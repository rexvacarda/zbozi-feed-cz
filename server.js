import express from "express";
import "dotenv/config";
import { create } from "xmlbuilder2";

const app = express();

const SHOP_MYSHOPIFY_DOMAIN = process.env.SHOP_MYSHOPIFY_DOMAIN; // creedperfumesamples.myshopify.com
const SHOP_PUBLIC_DOMAIN = process.env.SHOP_PUBLIC_DOMAIN; // smelltoimpress.cz
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 3000);

// Default delivery time in days (Zbozi: 0=immediately, 1=next day, 3=~3 days etc.)
const DELIVERY_DATE_DEFAULT = Number(process.env.DELIVERY_DATE_DEFAULT || 3);

if (!SHOP_MYSHOPIFY_DOMAIN || !SHOP_PUBLIC_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing env vars. Need SHOP_MYSHOPIFY_DOMAIN, SHOP_PUBLIC_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET."
  );
  process.exit(1);
}

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAdminAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 60_000) return cachedToken; // refresh 60s early

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch(`https://${SHOP_MYSHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) throw new Error(`Token HTTP ${res.status}: ${await res.text()}`);

  const json = await res.json();
  if (!json.access_token) throw new Error(`Token response missing access_token: ${JSON.stringify(json)}`);

  cachedToken = json.access_token;
  cachedTokenExpiresAt = Date.now() + json.expires_in * 1000;
  return cachedToken;
}

/**
 * Decode a small set of common HTML entities that may appear in Shopify HTML.
 * Most importantly: &nbsp; is NOT a valid XML entity and will break XML parsers.
 */
function decodeBasicEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/**
 * Make text safe for XML building:
 * - remove/convert problematic HTML entities (e.g. &nbsp;)
 * - normalize whitespace
 */
function xmlSafeText(s) {
  if (!s) return "";
  return decodeBasicEntities(s).replace(/\s+/g, " ").trim();
}

function cleanDescription(text) {
  if (!text) return "";
  const t = xmlSafeText(text);
  return t.length > 320 ? t.slice(0, 317) + "..." : t;
}

function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTranslation(translations, key) {
  const t = (translations || []).find((x) => x.key === key);
  return t?.value || "";
}

function formatPrice(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  // Feedyio often outputs without decimals; but Zbozi accepts decimals too.
  // Keep 2 decimals for safety/consistency.
  return n.toFixed(2);
}

async function adminGraphQL(query, variables = {}) {
  const token = await getAdminAccessToken();

  const res = await fetch(`https://${SHOP_MYSHOPIFY_DOMAIN}/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`Admin GraphQL HTTP ${res.status}: ${await res.text()}`);

  const json = await res.json();
  if (json.errors?.length) throw new Error(`Admin GraphQL errors: ${JSON.stringify(json.errors)}`);

  return json.data;
}

function firstImageUrl(p) {
  return p.featuredImage?.url || p.images?.edges?.[0]?.node?.url || "";
}

function alternativeImageUrls(p, primaryUrl) {
  const urls = (p.images?.edges || []).map((e) => e?.node?.url).filter(Boolean);
  const unique = [...new Set(urls)];
  return unique.filter((u) => u !== primaryUrl).slice(0, 10);
}

function pickInStockVariant(variantEdges) {
  // Exclude out-of-stock: require inventoryQuantity > 0
  for (const e of variantEdges || []) {
    const v = e.node;
    if (typeof v.inventoryQuantity === "number" && v.inventoryQuantity > 0) return v;
  }
  return null;
}

function findSizeValue(selectedOptions) {
  const opts = selectedOptions || [];
  const hit =
    opts.find((o) => (o?.name || "").toLowerCase() === "size") ||
    opts.find((o) => (o?.name || "").toLowerCase() === "velikost");
  return hit?.value ? xmlSafeText(hit.value) : "";
}

function buildZboziXml(items) {
  // IMPORTANT: namespace required by Zbozi
  const root = create({ version: "1.0", encoding: "UTF-8" })
    .ele("SHOP")
    .att("xmlns", "http://www.zbozi.cz/ns/offer/1.0");

  for (const item of items) {
    const si = root.ele("SHOPITEM");

    // Feedyio-style IDs (numeric)
    si.ele("ITEM_ID").txt(item.itemId); // variant legacyResourceId
    if (item.itemGroupId) si.ele("ITEMGROUP_ID").txt(item.itemGroupId); // product legacyResourceId

    si.ele("PRODUCTNAME").txt(item.productName);
    si.ele("URL").txt(item.url);
    si.ele("IMGURL").txt(item.imgUrl);
    si.ele("PRICE_VAT").txt(item.priceVat);

    if (item.manufacturer) si.ele("MANUFACTURER").txt(item.manufacturer);

    // Only include EAN if you actually have one (avoid empty tags)
    if (item.ean) si.ele("EAN").txt(item.ean);

    // Like Feedyio: internal code / name (SKU or your internal text)
    if (item.productNo) si.ele("PRODUCTNO").txt(item.productNo);

    // Like Feedyio
    si.ele("CONDITION").txt("new");

    si.ele("DESCRIPTION").txt(item.description);

    // Extra product images (repeatable)
    for (const alt of item.altImgUrls || []) {
      si.ele("IMGURL_ALTERNATIVE").txt(alt);
    }

    // Variant parameters (repeatable PARAM blocks)
    for (const p of item.params || []) {
      const param = si.ele("PARAM");
      param.ele("PARAM_NAME").txt(p.name);
      param.ele("VAL").txt(p.val);
    }

    si.ele("DELIVERY_DATE").txt(String(item.deliveryDate));
  }

  return root.end({ prettyPrint: true });
}

// Shared handler so /feed.xml and /feed-cz.xml serve the same output
async function feedHandler(req, res) {
  try {
    const query = `
      query ZboziAdminFeed($first: Int!, $after: String) {
        products(first: $first, after: $after, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              legacyResourceId
              title
              vendor
              handle
              descriptionHtml
              featuredImage { url }
              images(first: 10) { edges { node { url } } }

              translations(locale: "cs") {
                key
                value
              }

              variants(first: 50) {
                edges {
                  node {
                    legacyResourceId
                    sku
                    barcode
                    inventoryQuantity
                    selectedOptions { name value }

                    contextualPricing(context: { country: CZ }) {
                      price { amount currencyCode }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const items = [];
    let after = null;

    while (true) {
      const data = await adminGraphQL(query, { first: 100, after });
      const conn = data.products;

      for (const edge of conn.edges) {
        const p = edge.node;

        const v = pickInStockVariant(p.variants?.edges);
        if (!v) continue;

        const imgUrl = firstImageUrl(p);
        if (!imgUrl) continue;

        const translations = p.translations || [];

        const titleCsRaw = getTranslation(translations, "title") || p.title;
        const productName = xmlSafeText(titleCsRaw);

        const descHtmlCsRaw =
          getTranslation(translations, "description_html") ||
          getTranslation(translations, "body_html") ||
          p.descriptionHtml ||
          "";

        const description = cleanDescription(xmlSafeText(stripHtml(descHtmlCsRaw)));

        // CZ market pricing
        const cp = v.contextualPricing?.price;
        const priceVat = cp?.amount ? formatPrice(cp.amount) : "";
        if (!priceVat) continue; // if no price, better to skip than produce broken item

        // Feedyio-style: URL includes variant
        const variantIdNum = String(v.legacyResourceId || "").trim();
        if (!variantIdNum) continue;

        const url = `https://${SHOP_PUBLIC_DOMAIN}/products/${p.handle}?variant=${variantIdNum}`;

        const manufacturer = xmlSafeText(p.vendor || "");
        const ean = xmlSafeText(v.barcode || "");

        // Feedyio-like grouping numeric (product legacyResourceId)
        const itemGroupId = xmlSafeText(String(p.legacyResourceId || "").trim());

        // ITEM_ID numeric (variant legacyResourceId)
        const itemId = xmlSafeText(variantIdNum);

        // PRODUCTNO: prefer SKU, else fallback to product name (like your old internal id)
        const productNo = xmlSafeText(v.sku || "") || productName;

        // Alt images
        const altImgUrls = alternativeImageUrls(p, imgUrl);

        // PARAM: size (Velikost)
        const sizeVal = findSizeValue(v.selectedOptions);
        const params = [];
        if (sizeVal) {
          params.push({ name: "Velikost", val: sizeVal });
        }

        items.push({
          itemId,
          itemGroupId,
          productName,
          description,
          url: xmlSafeText(url),
          imgUrl: xmlSafeText(imgUrl),
          altImgUrls: altImgUrls.map(xmlSafeText),
          priceVat: xmlSafeText(priceVat),
          manufacturer,
          ean,
          productNo,
          params,
          deliveryDate: DELIVERY_DATE_DEFAULT,
        });
      }

      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }

    const xml = buildZboziXml(items);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).type("application/json").send(
      JSON.stringify(
        {
          error: String(err?.message || err),
          hint:
            "Ensure Dev Dashboard app scopes include read_products and read_inventory, and the app is installed on this store. If CZK pricing is blank, ensure Markets/pricing for CZ is configured.",
        },
        null,
        2
      )
    );
  }
}

// New CZ feed name
app.get("/feed-cz.xml", feedHandler);

// Keep old endpoint too (optional)
app.get("/feed.xml", feedHandler);

app.get("/", (req, res) =>
  res
    .type("text")
    .send("OK. Use /feed-cz.xml (Czech feed). Also available: /feed.xml")
);

app.listen(PORT, () => {
  console.log(`Feed server running: http://localhost:${PORT}/feed-cz.xml`);
});
