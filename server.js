/**
 * Daftra Order Proxy
 * ---------------------------------------------------------------
 * Sits between the customer-facing iPad app and Daftra's API.
 *
 * Flow:
 *
 *   iPad
 *     |
 *     | order JSON
 *     v
 *   This server
 *     |
 *     | 1. Get open POS shift
 *     | 2. Get shift ID
 *     | 3. Create invoice with pos_shift_id
 *     v
 *   Daftra
 *
 * The Daftra API key stays on the server and is never sent to the iPad.
 * ---------------------------------------------------------------
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();


// ---------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------

app.use(cors());
app.use(express.json());


// ---------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------

const {
  DAFTRA_SUBDOMAIN,   // Example: "healthyLifeDiet"
  DAFTRA_API_KEY,     // Daftra API Key
  DAFTRA_CLIENT_ID,   // Daftra client ID
  PORT = 3000,
} = process.env;


// ---------------------------------------------------------------
// Check configuration
// ---------------------------------------------------------------

function configOk() {
  return Boolean(
    DAFTRA_SUBDOMAIN &&
    DAFTRA_API_KEY &&
    DAFTRA_CLIENT_ID
  );
}


// ---------------------------------------------------------------
// Health check
// ---------------------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    configured: configOk(),
  });
});


// ===============================================================
// GET OPEN POS SHIFT
// ===============================================================
//
// Daftra endpoint:
//
// /v2/api/entity/pos_shift/list/1?filter[status]=1
//
// Response from your Daftra account:
//
// {
//   "data": [
//     {
//       "id": 512,
//       "staff_id": 1,
//       "shift_id": 0,
//       "pos_id": 2,
//       "warehouse_id": 1,
//       "status": 1,
//       "currency_code": "SAR"
//     }
//   ]
// }
//
// We need:
//
// data[0].id
//
// Example:
//
// 512
//
// Then this value will be sent to the invoice as:
//
// pos_shift_id: 512
//
// ===============================================================

async function getOpenPosShift() {

  const daftraBase =
    `https://${DAFTRA_SUBDOMAIN}.daftra.com`;


  const response = await fetch(
    `${daftraBase}/v2/api/entity/pos_shift/list/1?filter[status]=1`,
    {
      method: "GET",

      headers: {
        "Accept": "application/json",
        "apikey": DAFTRA_API_KEY,
      },
    }
  );


  const data = await response.json();


  // Log the complete response for debugging
  console.log(
    "Daftra Open POS Shift Response:",
    JSON.stringify(data, null, 2)
  );


  // Check HTTP response
  if (!response.ok) {

    throw new Error(
      data?.message ||
      "Could not get open POS shift from Daftra."
    );
  }


  // Make sure Daftra returned data
  if (
    !Array.isArray(data?.data) ||
    data.data.length === 0
  ) {

    throw new Error(
      "No open POS shift found in Daftra."
    );
  }


  // -------------------------------------------------------------
  // IMPORTANT
  // Your Daftra response shows:
  //
  // data[0].id = 512
  //
  // So this is the POS SHIFT ID we need.
  // -------------------------------------------------------------

  const posShiftId =
    data.data[0].id;


  if (!posShiftId) {

    throw new Error(
      "Open POS shift was found, but its ID is missing."
    );
  }


  console.log(
    "Using Daftra POS Shift ID:",
    posShiftId
  );


  return Number(posShiftId);
}


// ===============================================================
// CREATE ORDER / INVOICE
// ===============================================================

app.post("/api/create-order", async (req, res) => {


  // -------------------------------------------------------------
  // Check server configuration
  // -------------------------------------------------------------

  if (!configOk()) {

    return res.status(500).json({
      success: false,

      error:
        "Server is missing DAFTRA_SUBDOMAIN / DAFTRA_API_KEY / DAFTRA_CLIENT_ID.",
    });
  }


  // -------------------------------------------------------------
  // Get order data from iPad
  // -------------------------------------------------------------

  const {
    items,
    totals
  } = req.body || {};


  // -------------------------------------------------------------
  // Validate items
  // -------------------------------------------------------------

  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {

    return res.status(400).json({
      success: false,
      error: "Order has no items.",
    });
  }


  // -------------------------------------------------------------
  // Convert order items to Daftra invoice items
  // -------------------------------------------------------------

  const InvoiceItem = items.map((it) => ({

    item:
      `${it.name || "Item"} (${it.grams}g)`,

    unit_price:
      Number(it.unitPrice) || 0,

    quantity: 1,

  }));


  // -------------------------------------------------------------
  // Build invoice notes
  // -------------------------------------------------------------

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
  // GET OPEN POS SHIFT
  // =============================================================

  let posShiftId;


  try {

    posShiftId =
      await getOpenPosShift();


    console.log(
      "================================="
    );

    console.log(
      "OPEN POS SHIFT ID:",
      posShiftId
    );

    console.log(
      "================================="
    );


  } catch (err) {

    console.error(
      "Could not get open POS shift:",
      err
    );


    return res.status(502).json({

      success: false,

      error:
        err.message ||
        "Could not get open POS shift from Daftra.",

    });
  }


  // =============================================================
  // CREATE INVOICE BODY
  // =============================================================

  const invoiceBody = {

    Invoice: {

      // Daftra client
      client_id:
        Number(DAFTRA_CLIENT_ID),


      // Invoice date
      date:
        new Date()
          .toISOString()
          .slice(0, 10),


      // Real invoice, not draft
      draft: false,


      // Currency
      currency_code: "SAR",


      // ---------------------------------------------------------
      // IMPORTANT
      //
      // Link the invoice to the currently open POS cashier shift.
      //
      // Example:
      //
      // pos_shift_id: 512
      //
      // ---------------------------------------------------------

      pos_shift_id:
        posShiftId,


      // Unique order ID
      unique_id:
        String(Date.now()),


      // Notes
      notes:
        noteLines.join(" | "),

    },


    // Invoice items
    InvoiceItem,

  };


  // -------------------------------------------------------------
  // Log invoice before sending it to Daftra
  // -------------------------------------------------------------

  console.log(
    "================================="
  );

  console.log(
    "CREATING DAFTRA INVOICE"
  );

  console.log(
    JSON.stringify(
      invoiceBody,
      null,
      2
    )
  );

  console.log(
    "================================="
  );


  // =============================================================
  // DAFTRA API
  // =============================================================

  const daftraBase =
    `https://${DAFTRA_SUBDOMAIN}.daftra.com/api2`;


  try {


    // -----------------------------------------------------------
    // Create invoice
    // -----------------------------------------------------------

    const createRes =
      await fetch(
        `${daftraBase}/invoices.json`,
        {

          method: "POST",

          headers: {

            "Content-Type":
              "application/json",

            "Accept":
              "application/json",

            "apikey":
              DAFTRA_API_KEY,

          },

          body:
            JSON.stringify(invoiceBody),

        }
      );


    // -----------------------------------------------------------
    // Read Daftra response
    // -----------------------------------------------------------

    const createData =
      await createRes.json();


    console.log(
      "Daftra Create Invoice Response:",
      JSON.stringify(
        createData,
        null,
        2
      )
    );


    // -----------------------------------------------------------
    // Check if Daftra rejected the invoice
    // -----------------------------------------------------------

    if (
      !createRes.ok ||
      (
        createData.code &&
        createData.code >= 400
      )
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


    // -----------------------------------------------------------
    // Get invoice ID
    // -----------------------------------------------------------

    const invoiceId =
      createData.id;


    let invoiceNumber =
      invoiceId;


    // ===========================================================
    // GET HUMAN-READABLE INVOICE NUMBER
    // ===========================================================

    try {


      const detailRes =
        await fetch(
          `${daftraBase}/invoices/${invoiceId}.json`,
          {

            method: "GET",

            headers: {

              "Accept":
                "application/json",

              "apikey":
                DAFTRA_API_KEY,

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


    } catch (err) {

      // This is not fatal.
      // The invoice was already created successfully.

      console.warn(
        "Could not fetch invoice number:",
        err.message
      );

    }


    // ===========================================================
    // RETURN SUCCESS TO IPAD
    // ===========================================================

    return res.json({

      success: true,

      invoiceId,

      invoiceNumber,

      // Return the POS shift too for debugging / confirmation
      posShiftId,

    });


  } catch (err) {


    console.error(
      "Proxy -> Daftra request failed:",
      err
    );


    return res.status(500).json({

      success: false,

      error:
        "Could not reach Daftra.",

    });

  }

});


// ===============================================================
// CHECK OPEN POS SHIFT
// ===============================================================
//
// You can open:
//
// GET /api/check-pos-shift
//
// This will return the same response from Daftra.
//
// ===============================================================

app.get(
  "/api/check-pos-shift",
  async (req, res) => {


    const daftraBase =
      `https://${DAFTRA_SUBDOMAIN}.daftra.com`;


    try {


      const r =
        await fetch(
          `${daftraBase}/v2/api/entity/pos_shift/list/1?filter[status]=1`,
          {

            method: "GET",

            headers: {

              "Accept":
                "application/json",

              "apikey":
                DAFTRA_API_KEY,

            },

          }
        );


      const data =
        await r.json();


      console.log(
        "Daftra Open POS Shifts:",
        JSON.stringify(
          data,
          null,
          2
        )
      );


      return res
        .status(r.status)
        .json(data);


    } catch (err) {


      console.error(
        "POS Shift error:",
        err
      );


      return res.status(500).json({

        success: false,

        error:
          err.message,

      });

    }

  }
);


// ===============================================================
// START SERVER
// ===============================================================

app.listen(
  PORT,
  () => {

    console.log(
      `Daftra order proxy listening on port ${PORT}`
    );


    if (!configOk()) {

      console.warn(
        "⚠ Missing env vars — see .env.example."
      );

      console.warn(
        "⚠ /api/create-order will fail until they are set."
      );

    }

  }
);
