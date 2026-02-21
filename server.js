import express from "express";

const app = express();

const {
  PORT = 3000,

  // Shopify
  SHOP_MYSHOPIFY_DOMAIN, // e.g. "smelltoimpress.myshopify.com"
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,

  // Public CZ shop URL for product links
  CZ_PUBLIC_DOMAIN, // e.g. "https://smelltoimpress.com/cs" OR "https://smelltoimpress.cz"

  // Feed controls
  FEED_CACHE_SECONDS = "900",
  CZ_ONLY_IN_STOCK = "true",

  // Optional defaults
  BRAND_FALLBACK = "SmellToImpress",
  CZ_GOOGLE_PRODUCT_CATEGORY = "Health & Beauty > Personal Care > Cosmetics > Perfume & Cologne",

  // If your store returns EUR from Shopify contextualPricing but you need CZK,
  // set FX_CZK_PER_EUR (e.g. 25.2). Leave empty if Shopify already returns CZK.
  FX_CZK_PER_EUR = ""
} = process.env;

function must(v, name) {
  if (!v) throw new Error(`Missing env var: ${name}`);
}

function boolEnv(v, fallback = false) {
  if (v == null) return fallback;
  return String(v).toLowerCase() === "true";
}

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlEscape(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeBaseUrl(input) {
  const s = String(input || "").trim();
  if (!s) return s;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return `https://${s}`;
}

function buildProductLink(baseUrl, handle, variantIdNumeric) {
  const clean = normalizeBaseUrl(baseUrl).replace(/\/$/, "");
  const url = new URL(`${clean}/products/${handle}`);
  if (variantIdNumeric) url.searchParams.set("variant", String(variantIdNumeric));
  return url.toString();
}

/**
 * Google Merchant "id" must be reasonably short.
 * Use Shopify numeric legacyResourceId first; cap SKU if used.
 */
function toShortGmcId(v) {
  if (v?.legacyResourceId) return String(v.legacyResourceId);

  const sku = String(v?.sku || "").trim();
  if (sku) return sku.slice(0, 50);

  const m = String(v?.id || "").match(/(\d+)\s*$/);
  if (m) return m[1];

  return "v";
}

// ----------------------
// Admin token (24h) cache
// ----------------------
let tokenCache = { token: null, expiresAtMs: 0 };

async function getAdminToken() {
  must(SHOP_MYSHOPIFY_DOMAIN, "SHOP_MYSHOPIFY_DOMAIN");
  must(SHOPIFY_CLIENT_ID, "SHOPIFY_CLIENT_ID");
  must(SHOPIFY_CLIENT_SECRET, "SHOPIFY_CLIENT_SECRET");

  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAtMs) return tokenCache.token;

  const url = `https://${SHOP_MYSHOPIFY_DOMAIN}/admin/oauth/access_token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials"
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token error ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error("No access_token returned from Shopify");

  tokenCache = {
    token: data.access_token,
    expiresAtMs: now + 23 * 60 * 60 * 1000
  };

  return tokenCache.token;
}

async function adminGraphQL(query, variables = {}) {
  const token = await getAdminToken();

  const res = await fetch(`https://${SHOP_MYSHOPIFY_DOMAIN}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Admin GraphQL HTTP ${res.status}: ${JSON.stringify(json).slice(0, 1000)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Admin GraphQL errors: ${JSON.stringify(json.errors).slice(0, 1500)}`);
  }
  return json.data;
}

// ----------------------
// Feed cache
// ----------------------
let feedCache = { xml: null, expiresAtMs: 0 };

function availabilityFromQty(qty) {
  return qty > 0 ? "in stock" : "out of stock";
}

function getTranslation(translations, key) {
  const t = (translations || []).find((x) => x.key === key);
  return t?.value || null;
}

function toCzkAmount(amountStr, currencyCode) {
  const amount = Number(amountStr);
  if (!Number.isFinite(amount)) return null;

  // If Shopify already returns CZK, keep it.
  if (String(currencyCode).toUpperCase() === "CZK") {
    return { amount: amount.toFixed(2), currency: "CZK" };
  }

  // If Shopify returns EUR (common), optionally convert using FX_CZK_PER_EUR.
  if (String(currencyCode).toUpperCase() === "EUR") {
    const fx = Number(FX_CZK_PER_EUR);
    if (!Number.isFinite(fx) || fx <= 0) {
      // No FX provided -> cannot safely convert
      return null;
    }
    const czk = amount * fx;
    return { amount: czk.toFixed(2), currency: "CZK" };
  }

  // Unknown currency -> cannot safely convert
  return null;
}

async function fetchAllProductsPaginated() {
  const query = `
    query Products($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            legacyResourceId
            handle
            title
            vendor
            descriptionHtml
            featuredImage { url }
            images(first: 1) { edges { node { url } } }

            translations(locale: "cs") {
              key
              value
            }

            variants(first: 100) {
              edges {
                node {
                  id
                  legacyResourceId
                  title
                  sku
                  barcode
                  inventoryQuantity

                  contextualPricing(context: {country: CZ}) {
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

  let after = null;
  const all = [];

  while (true) {
    const data = await adminGraphQL(query, { first: 100, after });
    const conn = data.products;

    for (const e of conn.edges) all.push(e.node);

    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  return all;
}

app.get("/health", (_, res) => res.status(200).send("ok"));

app.get("/feed-cz.xml", async (_, res) => {
  try {
    must(CZ_PUBLIC_DOMAIN, "CZ_PUBLIC_DOMAIN");

    const now = Date.now();
    const ttlMs = Number(FEED_CACHE_SECONDS) * 1000;

    if (feedCache.xml && now < feedCache.expiresAtMs) {
      res.setHeader("Content-Type", "application/rss+xml; charset=UTF-8");
      res.setHeader("Cache-Control", `public, max-age=${Math.max(60, Number(FEED_CACHE_SECONDS))}`);
      return res.status(200).send(feedCache.xml);
    }

    const onlyInStock = boolEnv(CZ_ONLY_IN_STOCK, true);
    const products = await fetchAllProductsPaginated();

    let itemsXml = "";

    for (const p of products) {
      const img =
        p.featuredImage?.url ||
        p.images?.edges?.[0]?.node?.url ||
        "";

      // Prefer Czech translations when present
      const titleCS = getTranslation(p.translations, "title") || p.title;
      const bodyCS = getTranslation(p.translations, "body_html") || p.descriptionHtml;

      const description =
        stripHtml(bodyCS) ||
        stripHtml(p.descriptionHtml) ||
        titleCS;

      const brand = p.vendor || BRAND_FALLBACK;

      for (const ve of (p.variants?.edges || [])) {
        const v = ve.node;

        const qty = Number(v.inventoryQuantity ?? 0);
        if (onlyInStock && qty <= 0) continue;

        const priceObj = v.contextualPricing?.price;
        if (!priceObj?.amount) continue;

        // Ensure CZK (either Shopify returns CZK, or convert from EUR using FX_CZK_PER_EUR)
        const czk = toCzkAmount(priceObj.amount, priceObj.currencyCode);
        if (!czk) continue; // skip if cannot produce CZK reliably

        // ✅ Short, stable ID. If you run multiple country feeds as primary, append -CZ to avoid collisions.
        const gid = `${toShortGmcId(v)}-CZ`;

        const variantTitle =
          v.title && v.title !== "Default Title"
            ? `${titleCS} - ${v.title}`
            : titleCS;

        const link = buildProductLink(CZ_PUBLIC_DOMAIN, p.handle, v.legacyResourceId);

        const gtinXml = ""; 
        const mpnXml = ""; 
        const identifierExistsXml = `<g:identifier_exists>false</g:identifier_exists>`;

        itemsXml += `
  <item>
    <g:id>${xmlEscape(gid)}</g:id>
    <g:title>${xmlEscape(variantTitle)}</g:title>
    <g:description>${xmlEscape(description)}</g:description>
    <g:link>${xmlEscape(link)}</g:link>
    <g:image_link>${xmlEscape(img)}</g:image_link>
    <g:availability>${availabilityFromQty(qty)}</g:availability>
    <g:price>${xmlEscape(`${czk.amount} ${czk.currency}`)}</g:price>
    <g:condition>new</g:condition>
    <g:brand>${xmlEscape(brand)}</g:brand>
    <g:google_product_category>${xmlEscape(CZ_GOOGLE_PRODUCT_CATEGORY)}</g:google_product_category>
    ${gtinXml}
    ${mpnXml}
    ${identifierExistsXml}
  </item>`;
      }
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
  <title>${xmlEscape("SmellToImpress Czech Republic")}</title>
  <link>${xmlEscape(normalizeBaseUrl(CZ_PUBLIC_DOMAIN))}</link>
  <description>${xmlEscape("Google Merchant Center feed (CZ)")}</description>
  <language>cs</language>
  ${itemsXml}
</channel>
</rss>
`;

    feedCache = { xml, expiresAtMs: Date.now() + ttlMs };

    res.setHeader("Content-Type", "application/rss+xml; charset=UTF-8");
    res.setHeader("Cache-Control", `public, max-age=${Math.max(60, Number(FEED_CACHE_SECONDS))}`);
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).json({ error: "CZ feed failed", message: err?.message || String(err) });
  }
});

app.listen(PORT, () => console.log(`GMC CZ feed running on :${PORT}`));