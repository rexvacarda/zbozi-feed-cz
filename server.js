import express from "express";
import "dotenv/config";
import { create } from "xmlbuilder2";

const app = express();

const SHOP_MYSHOPIFY_DOMAIN = process.env.SHOP_MYSHOPIFY_DOMAIN;
const SHOP_PUBLIC_DOMAIN = process.env.SHOP_PUBLIC_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 3000);

// GLAMI FIX: delivery should look immediate / next day
const DELIVERY_DATE_DEFAULT = Number(process.env.DELIVERY_DATE_DEFAULT || 1);

const DELIVERY_ID_DEFAULT = xmlSafeEnv(process.env.DELIVERY_ID_DEFAULT || "UPS");
const DELIVERY_PRICE_DEFAULT = Number(process.env.DELIVERY_PRICE_DEFAULT || 0);
const DELIVERY_PRICE_COD_DEFAULT = Number(process.env.DELIVERY_PRICE_COD_DEFAULT || 0);

const FEED_CACHE_SECONDS = Number(process.env.FEED_CACHE_SECONDS || 900);
let cachedFeedXml = "";
let cachedFeedUntil = 0;

if (!SHOP_MYSHOPIFY_DOMAIN || !SHOP_PUBLIC_DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing env vars.");
  process.exit(1);
}

function xmlSafeEnv(s) {
  return (s || "").toString().trim();
}

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAdminAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 60_000) return cachedToken;

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
  cachedTokenExpiresAt = Date.now() + (Number(json.expires_in || 3600) * 1000);
  return cachedToken;
}

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

async function adminGraphQL(query, variables = {}) {
  const token = await getAdminAccessToken();
  const url = `https://${SHOP_MYSHOPIFY_DOMAIN}/admin/api/2025-07/graphql.json`;

  const res = await fetch(url, {
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

function firstImageUrl(p) {
  return p.featuredImage?.url || p.images?.edges?.[0]?.node?.url || "";
}

function alternativeImageUrls(p, primaryUrl) {
  const urls = (p.images?.edges || []).map((e) => e?.node?.url).filter(Boolean);
  const unique = [...new Set(urls)];
  return unique.filter((u) => u !== primaryUrl).slice(0, 10);
}

function inStockVariants(variantEdges) {
  return (variantEdges || [])
    .map(e => e.node)
    .filter(v => typeof v.inventoryQuantity === "number" && v.inventoryQuantity > 0);
}

// GLAMI FIX: extract only "2 ml" format
function findSizeValue(selectedOptions) {
  const opts = selectedOptions || [];
  const hit =
    opts.find((o) => (o?.name || "").toLowerCase() === "size") ||
    opts.find((o) => (o?.name || "").toLowerCase() === "velikost");

  if (!hit?.value) return "";

  const raw = hit.value.toLowerCase();
  const match = raw.match(/(\d+)\s?ml/);

  if (match) return `${match[1]} ml`;

  return "";
}

function getCategoryText() {
  return "Krása a zdraví | Parfémy | Unisex";
}

function buildZboziXml(items) {
  const root = create({ version: "1.0", encoding: "UTF-8" })
    .ele("SHOP")
    .att("xmlns", "http://www.zbozi.cz/ns/offer/1.0");

  for (const item of items) {
    const si = root.ele("SHOPITEM");

    si.ele("ITEM_ID").txt(item.itemId);
    si.ele("PRODUCTNAME").txt(item.productName);
    si.ele("URL").txt(item.url);
    si.ele("IMGURL").txt(item.imgUrl);
    si.ele("PRICE_VAT").txt(item.priceVat);
    si.ele("CATEGORYTEXT").txt(item.categoryText);

    if (item.manufacturer) si.ele("MANUFACTURER").txt(item.manufacturer);

    si.ele("CONDITION").txt("new");
    si.ele("DESCRIPTION").txt(item.description);

    for (const p of item.params || []) {
      const param = si.ele("PARAM");
      param.ele("PARAM_NAME").txt(p.name);
      param.ele("VAL").txt(p.val);
    }

    si.ele("DELIVERY_DATE").txt(String(item.deliveryDate));
  }

  return root.end({ prettyPrint: true });
}

async function feedHandler(req, res) {
  const query = `
    query {
      products(first: 100) {
        edges {
          node {
            title
            vendor
            handle
            descriptionHtml
            featuredImage { url }
            variants(first: 20) {
              edges {
                node {
                  legacyResourceId
                  barcode
                  inventoryQuantity
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
    const variants = inStockVariants(p.variants.edges);

    for (const v of variants) {
      const sizeVal = findSizeValue(v.selectedOptions);
      const params = [];
      if (sizeVal) params.push({ name: "Velikost", val: sizeVal });

      items.push({
        itemId: v.legacyResourceId,
        productName: xmlSafeText(p.title), // GLAMI FIX: no size
        description: cleanDescription(stripHtml(p.descriptionHtml)),
        url: `https://${SHOP_PUBLIC_DOMAIN}/products/${p.handle}?variant=${v.legacyResourceId}`,
        imgUrl,
        priceVat: formatPrice(v.contextualPricing.price.amount),
        manufacturer: p.vendor,
        params,
        deliveryDate: DELIVERY_DATE_DEFAULT,
        categoryText: getCategoryText(),
      });
    }
  }

  const xml = buildZboziXml(items);
  res.setHeader("Content-Type", "application/xml");
  res.send(xml);
}

app.get("/feed-cz.xml", feedHandler);
app.listen(PORT, () => console.log("Feed running"));


