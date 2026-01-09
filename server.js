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

// Cache generated XML to avoid hammering Shopify (important for Zbozi validation)
const FEED_CACHE_SECONDS = Number(process.env.FEED_CACHE_SECONDS || 900); // 15 min default
let cachedFeedXml = "";
let cachedFeedUntil = 0;

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
  return n.toFixed(2);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Throttle-aware Admin GraphQL with retries
async function adminGraphQL(query, variables = {}) {
  const token = await getAdminAccessToken();
  const url = `https://${SHOP_MYSHOPIFY_DOMAIN}/admin/api/2025-07/graphql.json`;

  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Admin GraphQL non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`);
    }

    // Handle HTTP throttling (429)
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") || "1");
      await sleep(Math.min(30, Math.max(1, retryAfter)) * 1000);
      continue;
    }

    const errors = json?.errors || [];
    const throttled = errors.some(
      (e) => e?.extensions?.code === "THROTTLED" || (e?.message || "").toLowerCase().includes("throttled")
    );

    // Shopify GraphQL cost throttle info (if provided)
    const throttle = json?.extensions?.cost?.throttleStatus;
    const restoreRate = Number(throttle?.restoreRate || 50);
    const currentlyAvailable = Number(throttle?.currentlyAvailable || 0);

    if (throttled) {
      // Wait enough to restore some points, otherwise exponential backoff
      let waitMs;
      if (Number.isFinite(restoreRate) && restoreRate > 0) {
        // Restore ~100 points (min 2s)
        waitMs = Math.max(2000, Math.ceil((100 / restoreRate) * 1000));
      } else {
        waitMs = Math.min(30000, 500 * Math.pow(2, attempt)); // 0.5s,1s,2s,4s.. max 30s
      }
      await sleep(waitMs);
      continue;
    }

    // Other GraphQL errors
    if (errors.length) {
      throw new Error(`Admin GraphQL errors: ${JSON.stringify(errors)}`);
    }

    // If we are near the limit, small pause
    if (Number.isFinite(currentlyAvailable) && currentlyAvailable < 50) {
      await sleep(1000);
    }

    if (!res.ok) {
      throw new Error(`Admin GraphQL HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    return json.data;
  }

  throw new Error("Admin GraphQL throttled too long; retries exhausted.");
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
  const root = create({ version: "1.0", encoding: "UTF-8" })
    .ele("SHOP")
    .att("xmlns", "http://www.zbozi.cz/ns/offer/1.0");

  for (const item of items) {
    const si = root.ele("SHOPITEM");

    si.ele("ITEM_ID").txt(item.itemId);
    if (item.itemGroupId) si.ele("ITEMGROUP_ID").txt(item.itemGroupId);

    si.ele("PRODUCTNAME").txt(item.productName);
    si.ele("URL").txt(item.url);
    si.ele("IMGURL").txt(item.imgUrl);
    si.ele("PRICE_VAT").txt(item.priceVat);

    if (item.manufacturer) si.ele("MANUFACTURER").txt(item.manufacturer);
    if (item.ean) si.ele("EAN").txt(item.ean);
    if (item.productNo) si.ele("PRODUCTNO").txt(item.productNo);

    si.ele("CONDITION").txt("new");
    si.ele("DESCRIPTION").txt(item.description);

    for (const alt of item.altImgUrls || []) {
      si.ele("IMGURL_ALTERNATIVE").txt(alt);
    }

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
    // Serve cached XML if fresh
    const now = Date.now();
    if (cachedFeedXml && now < cachedFeedUntil) {
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.status(200).send(cachedFeedXml);
      return;
    }

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
              images(first: 4) { edges { node { url } } }

              translations(locale: "cs") {
                key
                value
              }

              variants(first: 20) {
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
        if (!priceVat) continue;

        const variantIdNum = String(v.legacyResourceId || "").trim();
        if (!variantIdNum) continue;

        const url = `https://${SHOP_PUBLIC_DOMAIN}/products/${p.handle}?variant=${variantIdNum}`;

        const manufacturer = xmlSafeText(p.vendor || "");
        const ean = xmlSafeText(v.barcode || "");

        const itemGroupId = xmlSafeText(String(p.legacyResourceId || "").trim());
        const itemId = xmlSafeText(variantIdNum);

        const productNo = xmlSafeText(v.sku || "") || productName;

        const altImgUrls = alternativeImageUrls(p, imgUrl);

        const sizeVal = findSizeValue(v.selectedOptions);
        const params = [];
        if (sizeVal) params.push({ name: "Velikost", val: sizeVal });

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

    // Cache for FEED_CACHE_SECONDS
    cachedFeedXml = xml;
    cachedFeedUntil = Date.now() + FEED_CACHE_SECONDS * 1000;

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).type("application/json").send(
      JSON.stringify(
        {
          error: String(err?.message || err),
          hint:
            "If you see THROTTLED, increase FEED_CACHE_SECONDS and ensure Zbozi validation isn't repeatedly fetching during tests.",
        },
        null,
        2
      )
    );
  }
}

app.get("/feed-cz.xml", feedHandler);
app.get("/feed.xml", feedHandler);

app.get("/", (req, res) =>
  res.type("text").send("OK. Use /feed-cz.xml (Czech feed). Also available: /feed.xml")
);

app.listen(PORT, () => {
  console.log(`Feed server running: http://localhost:${PORT}/feed-cz.xml`);
});

