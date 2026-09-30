/**
 * Daftra Order Proxy
 * ---------------------------------------------------------------
 * Sits between the customer-facing iPad app and Daftra's API.
 *
 * Flow:
 *   iPad  --(order JSON, no secrets)-->  this proxy
 *   proxy --(order + API key)-->         Daftra API -> creates invoice
 *   proxy --(invoice number)-->          iPad
 *   cashier screen --(poll)-->           this proxy -> recent orders
 * ---------------------------------------------------------------
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());


// ===============================================================
// تخزين الطلبات الأخيرة لشاشة الكاشير
// ===============================================================

const recentOrders = [];


// ===============================================================
// Environment Variables
// ===============================================================

const {
  DAFTRA_SUBDOMAIN,
  DAFTRA_API_KEY,
  DAFTRA_CLIENT_ID,
  PORT = 3000,
} = process.env;


// ===============================================================
// Check Configuration
// ===============================================================

function configOk() {
  return Boolean(
    DAFTRA_SUBDOMAIN &&
    DAFTRA_API_KEY &&
    DAFTRA_CLIENT_ID
  );
}


// ===============================================================
// Health Check
// ===============================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    configured: configOk(),
  });
});


// ===============================================================
// Create Order
// ===============================================================

app.post("/api/create-order", async (req, res) => {

  if (!configOk()) {
    return res.status(500).json({
      success: false,
      error:
        "Server is missing DAFTRA_SUBDOMAIN / DAFTRA_API_KEY / DAFTRA_CLIENT_ID.",
    });
  }


  const { items, totals } = req.body || {};


  // التأكد من وجود المنتجات

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Order has no items.",
    });
  }


  // =============================================================
  // تجهيز منتجات الفاتورة
  // =============================================================

  const InvoiceItem = items.map((it) => ({
    item: `${it.name || "Item"} (${it.grams}g)`,
    unit_price: Number(it.unitPrice) || 0,
    quantity: 1,
  }));


  // =============================================================
  // ملاحظات الفاتورة
  // =============================================================

  const noteLines = [];


  if (totals) {

    noteLines.push(
      `${totals.calories ?? 0} kcal`
    );

    noteLines.push(
      `P ${totals.protein ?? 0}g / C ${totals.carbs ?? 0}g / F ${totals.fat ?? 0}g`
    );

  }


  noteLines.push(
    "Placed from the iPad meal builder"
  );


  // =============================================================
  // بيانات الفاتورة
  // =============================================================

  const invoiceBody = {

    Invoice: {

      client_id: Number(DAFTRA_CLIENT_ID),

      date: new Date()
        .toISOString()
        .slice(0, 10),

      draft: false,

      currency_code: "SAR",

      // رقم فريد لكل طلب
      unique_id: String(Date.now()),

      notes: noteLines.join(" | "),
    },

    InvoiceItem,
  };


  // =============================================================
  // Daftra URL
  // =============================================================

  const daftraBase =
    `https://${DAFTRA_SUBDOMAIN}.daftra.com/api2`;


  try {

    // ===========================================================
    // إرسال الفاتورة إلى Daftra
    // ===========================================================

    const createRes = await fetch(
      `${daftraBase}/invoices.json`,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "apikey": DAFTRA_API_KEY,
        },

        body: JSON.stringify(invoiceBody),
      }
    );


    const createData = await createRes.json();


    // ===========================================================
    // التحقق من رد Daftra
    // ===========================================================

    if (
      !createRes.ok ||
      (createData.code && createData.code >= 400)
    ) {

      console.error(
        "Daftra rejected the invoice:",
        createData
      );

      return res.status(502).json({

        success: false,

        error:
          createData.message ||
          "Daftra rejected the order.",

        details:
          createData.validation_errors ||
          null,
      });

    }


    // ===========================================================
    // رقم الفاتورة
    // ===========================================================

    const invoiceId = createData.id;

    let invoiceNumber = invoiceId;


    // ===========================================================
    // جلب رقم الفاتورة الحقيقي من Daftra
    // ===========================================================

    try {

      const detailRes = await fetch(
        `${daftraBase}/invoices/${invoiceId}.json`,
        {
          headers: {
            "Accept": "application/json",
            "apikey": DAFTRA_API_KEY,
          },
        }
      );


      if (detailRes.ok) {

        const detail =
          await detailRes.json();

        invoiceNumber =
          detail?.Invoice?.no ||
          invoiceId;

      }

    } catch (_) {

      // هذا الخطأ غير مؤثر
      // لأن الفاتورة نفسها تم إنشاؤها

    }


    // ===========================================================
    // حفظ الطلب لشاشة الكاشير
    // ===========================================================

    const order = {

      id: Date.now(),

      invoiceId,

      invoiceNumber,

      createdAt:
        new Date().toISOString(),

      items: items.map((it) => ({

        name:
          it.name ||
          "Item",

        grams:
          it.grams ||
          0,

        quantity:
          it.quantity ||
          1,

        unitPrice:
          Number(it.unitPrice) ||
          0,

      })),

      totals:
        totals ||
        null,

    };


    // إضافة الطلب في بداية القائمة

    recentOrders.unshift(order);


    // الاحتفاظ بآخر 50 طلب فقط

    if (recentOrders.length > 50) {

      recentOrders.length = 50;

    }


    console.log(
      "New order added to cashier:",
      order.invoiceNumber
    );


    // ===========================================================
    // الرد على الموقع
    // ===========================================================

    res.json({

      success: true,

      invoiceId,

      invoiceNumber,

    });


  } catch (err) {

    console.error(
      "Proxy -> Daftra request failed:",
      err
    );


    res.status(500).json({

      success: false,

      error:
        "Could not reach Daftra.",

    });

  }

});


// ===============================================================
// شاشة الكاشير - الطلبات الأخيرة
// ===============================================================

app.get("/api/recent-orders", (req, res) => {

  res.json({

    orders: recentOrders,

  });

});


// ===============================================================
// فحص جلسات POS في Daftra
// ===============================================================

app.get("/api/check-pos-shift", async (req, res) => {

  const daftraBase =
    `https://${DAFTRA_SUBDOMAIN}.daftra.com/api2`;


  try {

    const r = await fetch(
      `${daftraBase}/pos_shifts.json`,
      {
        method: "GET",

        headers: {
          "Accept": "application/json",
          "apikey": DAFTRA_API_KEY,
        },
      }
    );


    const data =
      await r.json();


    console.log(
      "Daftra POS Shift:",
      JSON.stringify(data, null, 2)
    );


    res
      .status(r.status)
      .json(data);


  } catch (err) {

    console.error(
      "POS Shift error:",
      err
    );


    res.status(500).json({

      success: false,

      error:
        err.message,

    });

  }

});


// ===============================================================
// Start Server
// ===============================================================

app.listen(PORT, () => {

  console.log(
    `Daftra order proxy listening on port ${PORT}`
  );


  if (!configOk()) {

    console.warn(
      "⚠ Missing env vars — see .env.example. /api/create-order will fail until they're set."
    );

  }

});
