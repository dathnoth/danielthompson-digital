// Dashboard settings. This is the only file you should need to edit when
// changing where the sales come from (see README.md).

export const CONFIG = {
  // Leave as null to use the outlet name found in the CuisineIQ exports
  // (which says "Coffee Lounge", the company name).
  shopName: "Le Coffee Shop",

  // Money formatting: Mauritian rupees, shown as "Rs".
  currency: "MUR",
  locale: "en-GB", // day-month-year dates, matching CuisineIQ's exports

  // Opening hours [open, close] by day (0 = Sunday), in shop time. Today's headline says
  // "Before opening" / "Today's result" by these, the evening recap shows from closing,
  // and the door counter status on the Tools tab only expects counts while it's open.
  openingHours: { 0: [7, 13], 1: [7, 18], 2: [7, 18], 3: [7, 18], 4: [7, 18], 5: [7, 18], 6: [7, 18] },

  // Where the sales come from:
  //   "auto"          – online: the Cloudflare database; on this computer: the CuisineIQ
  //                     exports in data/exports/; if neither has data, sample data
  //   "cloud"         – the Cloudflare database only
  //   "exports"       – CuisineIQ exports on this computer only
  //   "sample"        – sample data only
  //   "cuisineiq-api" – CuisineIQ's read-only API, once it exists (see js/data-source.js)
  source: "sample", // portfolio demo: sample data only

  exports: {
    url: "api/exports", // served by server.py from the files in data/exports/

    // CuisineIQ column headings the dashboard looks for. Matching ignores upper/lower
    // case, accents and extra spaces. The French alternatives are guesses for when the
    // CuisineIQ back office is set to French – add the real ones if they differ.
    labels: {
      printDate: ["Print date", "Date d'impression", "Date impression"],
      fromDate: ["From date", "Date début", "Du"],
      toDate: ["To date", "Date fin", "Au"],

      // Sales report (one row per day)
      date: ["Date"],
      discount: ["Discount Incl. Vat", "Remise TTC"],
      amountExclVat: ["Amount Excl. Vat", "Montant HT"],
      vat: ["Vat amount 15%", "Vat amount", "Montant TVA", "TVA"],
      amountInclVat: ["Amount Incl. Vat", "Montant TTC"],

      // Product sold report and POS product list
      outlet: ["Outlet", "Point de vente"],
      category: ["Category", "Catégorie", "Famille"],
      product: ["Product", "Produit", "Article"],
      quantity: ["Qty", "Quantity", "Qté", "Quantité"],
      productAmount: ["Amount Vat Included", "Montant TTC"],
      price: ["Price", "Prix"],
      qtySold: ["Qty sold", "Qté vendue", "Quantité vendue"],

      // Till-closing ("Close day") details and ticket journal
      amount: ["Montant", "Amount"],
      invoice: ["Invoice Number", "N° Facture", "Numéro de facture"],
      ticket: ["N° Ticket", "No Ticket", "Ticket No"],
    },

    // Sections of the till-closing details that list payments, and the name to show for each.
    // Cash isn't itemised in that export; it's worked out from the day's total.
    paymentSections: {
      "Credit Card": "Card",
      "Juice": "Juice (MCB mobile)",
      "Credit Customer": "Customer account",
      "Others": "Cheque / other",
    },
    // Ticket-journal section listing credit notes (refunds)
    creditNoteSections: ["Récapitulatif credit notes par vendeur", "Credit notes by seller"],

    // Left out of "Best sellers" (still counted in sales and categories).
    bestSellerExcludeCategories: ["Add-on", "Packaging & Stationery"],
  },

  cloud: {
    url: "api/dataset", // served by the Cloudflare Worker (src/worker.js) from D1
  },

  sample: {
    files: ["data/sample-sales.csv"],
  },

  "cuisineiq-api": {
    baseUrl: "", // e.g. "https://api.cuisineiq.example/v1" – to be confirmed by CuisineIQ
    // Never put a secret API key in this file if the dashboard is published on
    // the internet – see README.md, "Using the CuisineIQ API".
    apiKey: "",
    locationId: "",
    days: 90,
  },
};
