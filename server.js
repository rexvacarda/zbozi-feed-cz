import express from "express";
import "dotenv/config";
import { create } from "xmlbuilder2";

const app = express();

const SHOP_MYSHOPIFY_DOMAIN = process.env.SHOP_MYSHOPIFY_DOMAIN;
const SHOP_PUBLIC_DOMAIN = process.env.SHOP_PUBLIC_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 3000);

const DELIVERY_DATE_DEFAULT = Number(process.env.DELIVERY_DATE_DEFAULT || 3);

const DELIVERY_ID_DEFAULT = xmlSafeEnv(process.env.DELIVERY_ID_DEFAULT || "UPS");
const DELIVERY_PRICE_DEFAULT = Number(process.env.DELIVERY_PRICE_DEFAULT || 0);

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
  cachedTokenExpiresAt = Date.now() + json.expires_in * 1000;
  return cachedToken;
}

function xmlSafeText(s) {
  if (!s) return "";
  return String(s).replace(/\s+/g, " ").trim();
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

/* ================================
   REMOVE UI WORDS FROM DESCRIPTION
================================ */

function removeUiWords(text) {
  if (!text) return "";
  let t = String(text);

  t = t.replace(/\bDomů\b/gi, " ");
  t = t.replace(/\bČeština\b/gi, " ");
  t = t.replace(/›/g, " ");

  return t.replace(/\s+/g, " ").trim();
}

/* ================================
   GLAMI PRODUCTNAME CLEAN
================================ */

function normalizeSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function removeSizeFromName(name) {
  let s = String(name || "");

  s = s.replace(/\s*\b\d+(?:[.,]\d+)?\s*ml\b/gi, " ");
  s = s.replace(/\s*\b\d+(?:[.,]\d+)?\s*(?:(?:fl\.?\s*)?(?:o\.?\s*)?z\.?|oz\.?)\b/gi, " ");
  s = s.replace(/\s*[.,]\s*/g, " ");
  s = s.replace(/\(\s*\)/g, " ");

  return normalizeSpaces(s);
}

function formatPrice(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(2);
}

/**
 * keep official samples (inventory not tracked)
 */
function inStockVariants(variantEdges) {
  const out = [];
  for (const e of variantEdges || []) {
    const v = e.node;
    const qty = v.inventoryQuantity;

    const tracked = typeof qty === "number";
    const hasStock = tracked && qty > 0;
    const notTracked = qty === null || qty === undefined;

    if (hasStock || notTracked) out.push(v);
  }
  return out;
}

function findSizeValue(selectedOptions) {
  const opts = selectedOptions || [];
  const hit =
    opts.find((o) => (o?.name || "").toLowerCase() === "size") ||
    opts.find((o) => (o?.name || "").toLowerCase() === "velikost");

  if (!hit?.value) return "";

  const raw = String(hit.value).toLowerCase();
  const match = raw.match(/(\d+(?:\.\d+)?)\s*ml/);

  return match ? `${match[1]}ml` : "";
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

    si.ele("CATEGORYTEXT").txt("Krása a zdraví | Parfémy | Unisex");

    si.ele("MANUFACTURER").txt(item.manufacturer);
    si.ele("BRAND").txt(item.manufacturer); // 🔴 GLAMI BRAND TAG ADDED

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

    const del = si.ele("DELIVERY");
    del.ele("DELIVERY_ID").txt(DELIVERY_ID_DEFAULT);
    del.ele("DELIVERY_PRICE").txt(formatPrice(DELIVERY_PRICE_DEFAULT));
  }

  return root.end({ prettyPrint: true });
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

              variants(first: 50) {
                edges {
                  node {
                    legacyResourceId
                    sku
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

      const imgUrl = p.featuredImage?.url;
      if (!imgUrl) continue;

      const productNameBase = xmlSafeText(p.title);
      const productNameClean = removeSizeFromName(productNameBase);
      const manufacturer = xmlSafeText(p.vendor);

      const description = cleanDescription(
        removeUiWords(stripHtml(p.descriptionHtml))
      );

      const variants = inStockVariants(p.variants.edges);

      for (const v of variants) {
        const priceVat = formatPrice(v.contextualPricing.price.amount);
        const variantId = v.legacyResourceId;

        const sizeVal = findSizeValue(v.selectedOptions);
        const params = [];
        if (sizeVal) params.push({ name: "SIZE", val: sizeVal });

        items.push({
          itemId: variantId,
          itemGroupId: p.legacyResourceId,
          productName: productNameClean,
          description,
          url: `https://${SHOP_PUBLIC_DOMAIN}/products/${p.handle}?variant=${variantId}`,
          imgUrl,
          priceVat,
          manufacturer,
          ean: v.barcode,
          productNo: v.sku || productNameBase,
          params,
          deliveryDate: DELIVERY_DATE_DEFAULT,
          altImgUrls: [],
        });
      }
    }

    const xml = buildZboziXml(items);

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
