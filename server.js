import express from "express";
import "dotenv/config";
import { create } from "xmlbuilder2";

const app = express();

const SHOP_MYSHOPIFY_DOMAIN = process.env.SHOP_MYSHOPIFY_DOMAIN;
const SHOP_PUBLIC_DOMAIN = process.env.SHOP_PUBLIC_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 3000);

// DELIVERY — realistic GLAMI values
const DELIVERY_DATE_DEFAULT = Number(process.env.DELIVERY_DATE_DEFAULT || 3);
const DELIVERY_ID_DEFAULT = (process.env.DELIVERY_ID_DEFAULT || "GLS").trim();
const DELIVERY_PRICE_DEFAULT = Number(process.env.DELIVERY_PRICE_DEFAULT || 79);

// Cache
const FEED_CACHE_SECONDS = Number(process.env.FEED_CACHE_SECONDS || 900);
let cachedFeedXml = "";
let cachedFeedUntil = 0;

if (!SHOP_MYSHOPIFY_DOMAIN || !SHOP_PUBLIC_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing env vars");
  process.exit(1);
}

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAdminAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 60000) return cachedToken;

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

  const json = await res.json();
  cachedToken = json.access_token;
  cachedTokenExpiresAt = Date.now() + json.expires_in * 1000;
  return cachedToken;
}

function xmlSafeText(s) {
  if (!s) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function cleanDescription(text) {
  const t = xmlSafeText(text);
  return t.length > 320 ? t.slice(0, 317) + "..." : t;
}

function formatPrice(amount) {
  const n = Number(amount);
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

function getTranslation(translations, key) {
  const t = (translations || []).find((x) => x.key === key);
  return t?.value || "";
}

function firstImageUrl(p) {
  return p.featuredImage?.url || p.images?.edges?.[0]?.node?.url || "";
}

function alternativeImageUrls(p, primaryUrl) {
  const urls = (p.images?.edges || []).map((e) => e.node.url).filter(Boolean);
  return [...new Set(urls)].filter((u) => u !== primaryUrl).slice(0, 10);
}

/**
 * FIXED STOCK LOGIC
 * keeps:
 * - inventory >0
 * - inventory not tracked (official samples)
 */
function inStockVariants(variantEdges) {
  const out = [];

  for (const e of variantEdges || []) {
    const v = e.node;
    const qty = v.inventoryQuantity;

    const inventoryTracked = typeof qty === "number";
    const hasStock = inventoryTracked && qty > 0;
    const inventoryNotTracked = qty === null || qty === undefined;

    if (hasStock || inventoryNotTracked) {
      out.push(v);
    }
  }

  return out;
}

/**
 * GLAMI FIX (SIZE):
 * Extract only the FIRST "<number>ml" from the variant option value.
 * Supports decimals: 1.7ml, 2 ml, 10ML, etc.
 * Ignores fl oz completely.
 *
 * Example:
 * "Creed Aventus official perfume sample 1.7ml 0.06 fl. oz." -> "1.7ml"
 */
function findSizeValue(selectedOptions) {
  const opts = selectedOptions || [];
  const hit =
    opts.find((o) => (o?.name || "").toLowerCase() === "size") ||
    opts.find((o) => (o?.name || "").toLowerCase() === "velikost");

  if (!hit?.value) return "";

  const raw = String(hit.value).toLowerCase();

  // pick first number + optional decimal + ml
  const match = raw.match(/(\d+(?:\.\d+)?)\s*ml/);
  if (match) return `${match[1]}ml`;

  return "";
}

function getCategoryText() {
  return "Krása a zdraví | Parfémy";
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

  const json = await res.json();
  return json.data;
}

function buildXml(items) {
  const root = create({ version: "1.0", encoding: "UTF-8" })
    .ele("SHOP")
    .att("xmlns", "http://www.zbozi.cz/ns/offer/1.0");

  for (const item of items) {
    const si = root.ele("SHOPITEM");

    si.ele("ITEM_ID").txt(item.itemId);
    si.ele("PRODUCTNAME").txt(item.productName);
    si.ele("CATEGORYTEXT").txt(item.categoryText);
    si.ele("URL").txt(item.url);
    si.ele("IMGURL").txt(item.imgUrl);
    si.ele("PRICE_VAT").txt(item.priceVat);
    si.ele("DESCRIPTION").txt(item.description);
    si.ele("MANUFACTURER").txt(item.manufacturer);

    if (item.ean) si.ele("EAN").txt(item.ean);

    si.ele("DELIVERY_DATE").txt(String(item.deliveryDate));

    const del = si.ele("DELIVERY");
    del.ele("DELIVERY_ID").txt(DELIVERY_ID_DEFAULT);
    del.ele("DELIVERY_PRICE").txt(formatPrice(DELIVERY_PRICE_DEFAULT));

    if (item.size) {
      const param = si.ele("PARAM");
      // keep Czech label if you prefer (GLAMI is fine with either)
      param.ele("PARAM_NAME").txt("SIZE");
      param.ele("VAL").txt(item.size);
    }
  }

  return root.end({ prettyPrint: true });
}

async function feedHandler(req, res) {
  try {
    if (cachedFeedXml && Date.now() < cachedFeedUntil) {
      res.type("application/xml").send(cachedFeedXml);
      return;
    }

    const query = `
      query {
        products(first: 100, query: "status:active") {
          edges {
            node {
              legacyResourceId
              title
              vendor
              handle
              descriptionHtml
              featuredImage { url }
              images(first: 4) { edges { node { url } } }

              translations(locale: "cs") { key value }

              variants(first: 50) {
                edges {
                  node {
                    legacyResourceId
                    sku
                    barcode
                    inventoryQuantity
                    inventoryPolicy
                    selectedOptions { name value }
                    contextualPricing(context: { country: CZ }) {
                      price { amount }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await adminGraphQL(query);
    const items = [];

    for (const edge of data.products.edges) {
      const p = edge.node;

      const imgUrl = firstImageUrl(p);
      if (!imgUrl) continue;

      const productNameBase = xmlSafeText(p.title);
      const manufacturer = xmlSafeText(p.vendor);

      const description = cleanDescription(stripHtml(p.descriptionHtml));

      const variants = inStockVariants(p.variants.edges);

      for (const v of variants) {
        const priceVat = formatPrice(v.contextualPricing.price.amount);
        const variantId = v.legacyResourceId;

        const sizeVal = findSizeValue(v.selectedOptions);

        items.push({
          itemId: variantId,
          productName: productNameBase, // SIZE REMOVED from title
          categoryText: getCategoryText(),
          url: `https://${SHOP_PUBLIC_DOMAIN}/products/${p.handle}?variant=${variantId}`,
          imgUrl,
          priceVat,
          description,
          manufacturer,
          ean: v.barcode,
          size: sizeVal,
          deliveryDate: DELIVERY_DATE_DEFAULT,
        });
      }
    }

    const xml = buildXml(items);

    cachedFeedXml = xml;
    cachedFeedUntil = Date.now() + FEED_CACHE_SECONDS * 1000;

    res.type("application/xml").send(xml);
  } catch (err) {
    res.status(500).send(String(err));
  }
}

app.get("/feed-cz.xml", feedHandler);
app.get("/feed.xml", feedHandler);

app.listen(PORT, () => {
  console.log("Feed running");
});