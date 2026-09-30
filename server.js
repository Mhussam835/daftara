/**
 * Daftra Order Proxy
 * ---------------------------------------------------------------
 * Sits between the customer-facing iPad app and Daftra's API.
 *
 * Why this exists: the iPad page is public — anyone could open
 * their browser's dev tools and read any secret embedded in it.
 * So the Daftra API key never goes near the iPad. It lives only
 * here, as a server-side environment variable, and this tiny
 * server is the only thing that ever talks to Daftra directly.
 *
 * Flow:
 *   iPad  --(order JSON, no secrets)-->  this proxy
 *   proxy --(order + API key)-->         Daftra API  -> creates invoice
 *   proxy --(invoice number)-->          iPad (confirmation screen)
 *   cashier opens Daftra as usual -> sees the new invoice -> prints it
 * ---------------------------------------------------------------
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());              // tighten to your iPad's exact origin once it's hosted somewhere fixed
app.use(express.json());

const {
  DAFTRA_SUBDOMAIN,   // e.g. "myrestaurant" if your Daftra URL is myrestaurant.daftra.com
  DAFTRA_API_KEY,     // Settings -> API -> API Keys -> Generate API key
  DAFTRA_CLIENT_ID,   // the client_id Daftra should bill the sale to (see README)
  PORT = 3000,
} = process.env;

function configOk(){
  return Boolean(DAFTRA_SUBDOMAIN && DAFTRA_API_KEY && DAFTRA_CLIENT_ID);
}

app.get("/health", (req, res) => {
  res.json({ ok: true, configured: configOk() });
});

app.post("/api/create-order", async (req, res) => {
  if (!configOk()){
    return res.status(500).json({
      success: false,
      error: "Server is missing DAFTRA_SUBDOMAIN / DAFTRA_API_KEY / DAFTRA_CLIENT_ID.",
    });
  }

  const { items, totals } = req.body || {};
  if (!Array.isArray(items) || items.length === 0){
    return res.status(400).json({ success: false, error: "Order has no items." });
  }

  // Each selected ingredient becomes its own invoice line, priced for
  // the exact portion the customer chose (quantity is always 1 because
  // the weight is already baked into unitPrice).
  const InvoiceItem = items.map((it) => ({
    item: `${it.name || "Item"} (${it.grams}g)`,
    unit_price: Number(it.unitPrice) || 0,
    quantity: 1,
  }));

  const noteLines = [];
  if (totals){
    noteLines.push(`${totals.calories ?? 0} kcal`);
    noteLines.push(`P ${totals.protein ?? 0}g / C ${totals.carbs ?? 0}g / F ${totals.fat ?? 0}g`);
  }
  noteLines.push("Placed from the iPad meal builder");
 const invoiceBody = {
    Invoice: {
      client_id: Number(DAFTRA_CLIENT_ID),
      date: new Date().toISOString().slice(0, 10),
      draft: false,            // false = a real, final sale (not a draft)
      currency_code: "SAR",
    // رقم فريد لكل طلب
    unique_id: String(Date.now()),

      notes: noteLines.join(" | "),
    },
    InvoiceItem,
  };

  const daftraBase = `https://${DAFTRA_SUBDOMAIN}.daftra.com/api2`;

  try {
  const createRes = await fetch(`${daftraBase}/invoices.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "apikey": DAFTRA_API_KEY,
      },
      body: JSON.stringify(invoiceBody),
    });

    const createData = await createRes.json();

    if (!createRes.ok || (createData.code && createData.code >= 400)){
      console.error("Daftra rejected the invoice:", createData);
      return res.status(502).json({
        success: false,
        error: createData.message || "Daftra rejected the order.",
        details: createData.validation_errors || null,
      });
    }

    const invoiceId = createData.id;
    let invoiceNumber = invoiceId;

    // Best-effort: fetch the human-readable invoice number. If this
    // fails for any reason we still return success with the raw id.
    try {
      const detailRes = await fetch(`${daftraBase}/invoices/${invoiceId}.json`, {
        headers: { "Accept": "application/json", "apikey": DAFTRA_API_KEY },
      });
      if (detailRes.ok){
        const detail = await detailRes.json();
        invoiceNumber = detail?.Invoice?.no || invoiceId;
      }
    } catch (_) { /* non-fatal */ }

    res.json({ success: true, invoiceId, invoiceNumber });
  } catch (err) {
    console.error("Proxy -> Daftra request failed:", err);
    res.status(500).json({ success: false, error: "Could not reach Daftra." });
  }
});
app.get("/api/check-pos-shift", async (req, res) => {
  const daftraBase = `https://${DAFTRA_SUBDOMAIN}.daftra.com/api2`;

  try {
    const r = await fetch(`${daftraBase}/pos_shifts.json`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "apikey": DAFTRA_API_KEY,
      
      },
    });

    const data = await r.json();

    console.log("Daftra POS Shift:", JSON.stringify(data, null, 2));

    res.status(r.status).json(data);
  } catch (err) {
    console.error("POS Shift error:", err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});


app.listen(PORT, () => {
  console.log(`Daftra order proxy listening on port ${PORT}`);
  if (!configOk()){
    console.warn("⚠ Missing env vars — see .env.example. /api/create-order will fail until they're set.");
  }
});
