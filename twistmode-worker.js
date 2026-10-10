/* =========================================================
   TWISTMODE WORKER

   One Worker, two jobs:

     POST /create-checkout  → builds the Stripe order (cart,
                              colors, shipping by weight) and
                              hands back the Stripe link
     POST /wholesale        → emails you the wholesale request
                              with the weight and a shipping
                              estimate so you can quote it
     POST /contact          → the form on the homepage: color
                              requests, order questions, returns.
                              Each one goes to its own inbox.

   Stripe still holds the prices. This only sends Stripe the
   price IDs and quantities, so nobody can change a price in
   their browser.

   -----------------------------------------------------------
   SETTING IT UP IN CLOUDFLARE
   -----------------------------------------------------------
   1. Workers & Pages → Create → Worker → name it "twistmode-api"
      → Deploy → Edit code → paste this in → Deploy.

   2. Settings → Variables and Secrets:
        STRIPE_SECRET_KEY   Secret   sk_test_... now, sk_live_... at launch
        MAIL_FROM           Text     no-reply@shoptwistmode.com   (must be your domain)
        MAIL_TO             Text     support@shoptwistmode.com    (the catch-all)

      Optional — only if you want certain messages split out.
      Anything you leave off just goes to MAIL_TO:
        MAIL_WHOLESALE      Text     wholesale@shoptwistmode.com
        MAIL_RETURNS        Text     returns@shoptwistmode.com
        MAIL_QUESTIONS      Text     questions@shoptwistmode.com
        MAIL_COLORS         Text     colors@shoptwistmode.com

   3. Settings → Bindings → Add → Email send. Name it exactly:  EMAIL
      Every address above has to be verified first under
      Email → Email Routing → Destination addresses, or Cloudflare
      won't let the Worker send to it.

   4. Copy the Worker's .workers.dev URL and paste it into the
      ENDPOINT line near the bottom of index.html AND wholesale.html.
      (You don't need a route on shoptwistmode.com. If you add one
      later, the Worker handles that too.)
========================================================= */


/* =========================================================
   SETTINGS — EDIT THESE
========================================================= */

const SITE = "https://shoptwistmode.com";

/* Your Stripe prices. Sandbox IDs for now.
   At launch: copy the products to live mode, then paste the NEW
   live price IDs here AND in index.html (the data-price-id on
   each Add to Cart button). */
const PRODUCTS = {
  "price_1T22lRQVzg9AuHq0tMt1qdCJ": { key: "lite",   name: "TwistMode Lite",   price: 14.99 },
  "price_1T22ulQVzg9AuHq0F9BiKkGN": { key: "xl",     name: "TwistMode XL",     price: 29.99 },
  "price_1T23GbQVzg9AuHq0qEgFeqUb": { key: "bundle", name: "TwistMode Bundle", price: 39.99 }
};

/* Packed weight of ONE of each, in ounces (tool + mailer + padding).
   The tools themselves: Lite 23.5 g (0.83 oz), XL 49.9 g (1.76 oz).
   These numbers add a padded mailer and a little margin, rounded up
   so you're never under. Weigh your first real package to confirm. */
const WEIGHT_OZ = {
  lite: 2,
  xl: 3,
  bundle: 4
};

/* What the customer pays for shipping, by total weight.
   First row whose "upToOz" is >= the order weight wins.

   Almost every order lands in the first row: one Lite is 2 oz, one XL
   is 3 oz, a Bundle is 4 oz, and even two Bundles only reach 8 oz.
   Change these once you've bought a real label and know your cost. */
const SHIPPING_TIERS = [
  { upToOz: 8,        price: 5.49 },   // 1–2 tools, the usual order
  { upToOz: 16,       price: 7.49 },   // up to about 5 tools
  { upToOz: 48,       price: 10.99 },
  { upToOz: Infinity, price: 15.99 }
];

const SHIPPING_LABEL = "Standard Shipping";
const SHIPPING_DAYS = { min: 2, max: 6 };   // business days, shown at checkout

/* Free shipping at or above this order total. null turns it off. */
const FREE_SHIPPING_OVER = 75;

/* Wholesale: rough shipping cost for YOUR eyes only, to help you quote.
   Bulk orders go in one box, so the math here is the bare tools
   (Lite 0.83 oz, XL 1.76 oz) plus a box allowance. */
const WHOLESALE_MINIMUM = 10;
const BARE_OZ = { lite: 0.83, xl: 1.76 };
const WHOLESALE_BOX_OZ = 8;

const WHOLESALE_SHIPPING_TIERS = [
  { upToOz: 16,       price: 7 },
  { upToOz: 32,       price: 9 },
  { upToOz: 80,       price: 14 },
  { upToOz: 160,      price: 20 },
  { upToOz: 320,      price: 30 },
  { upToOz: Infinity, price: 0 }   // 0 = too big to guess, price it yourself
];

const ALLOWED_ORIGINS = [
  "https://shoptwistmode.com",
  "https://www.shoptwistmode.com"
];


/* =========================================================
   ROUTER
========================================================= */

export default {
  async fetch(request, env) {

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(request) });
    }

    if (request.method !== "POST") {
      return json(request, { error: "Not found" }, 404);
    }

    try {
      if (path.endsWith("/create-checkout")) {
        return await createCheckout(request, env);
      }

      if (path.endsWith("/wholesale") || path === "/") {
        return await handleWholesale(request, env);
      }

      if (path.endsWith("/contact")) {
        return await handleContact(request, env);
      }

      return json(request, { error: "Not found" }, 404);

    } catch (error) {
      console.error(error);
      return json(request, {
        success: false,
        error: "Something went wrong. Please try again."
      }, 500);
    }
  }
};


/* =========================================================
   CHECKOUT
========================================================= */

async function createCheckout(request, env) {

  if (!env.STRIPE_SECRET_KEY) {
    return json(request, { error: "Checkout isn't set up yet." }, 500);
  }

  const body = await request.json().catch(() => null);
  const cart = Array.isArray(body?.cart) ? body.cart : [];

  if (cart.length === 0 || cart.length > 20) {
    return json(request, { error: "Your cart is empty." }, 400);
  }

  /* Rebuild the order from OUR price list — never trust what
     the browser says something costs. */
  const items = [];

  for (const entry of cart) {

    const product = PRODUCTS[entry?.priceId];
    const qty = parseInt(entry?.qty, 10);

    if (!product || !(qty >= 1 && qty <= 25)) {
      return json(request, {
        error: "Something in your cart isn't available. Please refresh and try again."
      }, 400);
    }

    const colors = (Array.isArray(entry.colors) ? entry.colors : [])
      .map(color => clean(color?.name || color?.value, 40))
      .filter(Boolean)
      .slice(0, 2);

    items.push({ priceId: entry.priceId, product, qty, colors });
  }

  const subtotal = items.reduce((sum, i) => sum + i.product.price * i.qty, 0);
  const weightOz = items.reduce((sum, i) => sum + (WEIGHT_OZ[i.product.key] || 0) * i.qty, 0);
  const shippingCents = shippingFor(subtotal, weightOz);

  /* "2× TwistMode XL — Matte Black"
     "1× TwistMode Bundle — Lite: Blue / XL: Red" */
  const lines = items.map(item => {
    let colorText = "";
    if (item.colors.length === 2) colorText = ` — Lite: ${item.colors[0]} / XL: ${item.colors[1]}`;
    else if (item.colors.length === 1) colorText = ` — ${item.colors[0]}`;
    return `${item.qty}× ${item.product.name}${colorText}`;
  });

  const params = {
    mode: "payment",
    success_url: `${SITE}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE}/#checkout`,

    line_items: items.map(item => ({ price: item.priceId, quantity: item.qty })),

    shipping_address_collection: { allowed_countries: ["US"] },
    phone_number_collection: { enabled: true },

    shipping_options: [{
      shipping_rate_data: {
        type: "fixed_amount",
        display_name: shippingCents === 0 ? "Free Shipping" : SHIPPING_LABEL,
        fixed_amount: { amount: shippingCents, currency: "usd" },
        delivery_estimate: {
          minimum: { unit: "business_day", value: SHIPPING_DAYS.min },
          maximum: { unit: "business_day", value: SHIPPING_DAYS.max }
        }
      }
    }],

    /* Colors ride along on the order so you see them in Stripe. */
    metadata: orderMetadata(lines, weightOz),

    payment_intent_data: {
      description: clean(lines.join(" | "), 1000),
      metadata: orderMetadata(lines, weightOz)
    },

    /* And the customer sees them above the pay button. */
    custom_text: {
      submit: { message: clean("Your order: " + lines.join(", "), 1200) }
    }
  };

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: toForm(params)
  });

  const session = await response.json();

  if (!response.ok || !session.url) {
    console.error("Stripe error:", JSON.stringify(session.error || session));
    return json(request, { error: "Checkout couldn't open." }, 502);
  }

  return json(request, { url: session.url });
}


function shippingFor(subtotal, weightOz) {
  if (FREE_SHIPPING_OVER !== null && subtotal >= FREE_SHIPPING_OVER) return 0;
  const tier = SHIPPING_TIERS.find(t => weightOz <= t.upToOz) || SHIPPING_TIERS[SHIPPING_TIERS.length - 1];
  return Math.round(tier.price * 100);
}


function orderMetadata(lines, weightOz) {
  const meta = {};
  lines.slice(0, 40).forEach((line, index) => {
    meta[`item_${index + 1}`] = clean(line, 480);
  });
  meta.packed_weight_oz = String(weightOz);
  return meta;
}


/* =========================================================
   WHOLESALE
========================================================= */

async function handleWholesale(request, env) {

  const form = await request.formData().catch(() => null);

  if (!form) {
    return json(request, { success: false, error: "Couldn't read the form." }, 400);
  }

  /* Spam trap: the "website" box is hidden from real people. */
  if (clean(form.get("website"), 200)) {
    return json(request, { success: true });
  }

  const get = (name, max = 300) => clean(form.get(name), max);

  const order = {
    name: get("name", 120),
    business: get("business", 160),
    email: get("email", 160),
    mix: get("product_mix", 40),
    colors: get("preferred_colors", 2000),
    description: get("description", 1000),
    notes: get("notes", 2000),
    address: [
      get("shipping_address"),
      get("shipping_unit"),
      get("shipping_city"),
      get("shipping_state"),
      get("shipping_zip", 20)
    ].filter(Boolean).join(", ")
  };

  if (!order.name || !isEmail(order.email)) {
    return json(request, { success: false, error: "Please enter your name and a valid email." }, 400);
  }

  const counted = countUnits(order.colors);

  if (counted.total < WHOLESALE_MINIMUM) {
    return json(request, {
      success: false,
      error: `Wholesale orders start at ${WHOLESALE_MINIMUM} units.`
    }, 400);
  }

  const weightOz = Math.round(
    counted.lite * BARE_OZ.lite +
    counted.xl * BARE_OZ.xl +
    WHOLESALE_BOX_OZ
  );

  const tier = WHOLESALE_SHIPPING_TIERS.find(t => weightOz <= t.upToOz);
  const estimate = tier && tier.price > 0
    ? `about $${tier.price}`
    : "too heavy to estimate — price it yourself";

  const summary =
`NEW WHOLESALE REQUEST

From:      ${order.name}${order.business ? ` — ${order.business}` : ""}
Email:     ${order.email}
Mix:       ${order.mix || "—"}

ORDER
${order.colors || "—"}

Lite units:   ${counted.lite}
XL units:     ${counted.xl}
Total units:  ${counted.total}

SHIPPING ESTIMATE
Packed weight:  ${formatWeight(weightOz)}
Est. shipping:  ${estimate}
Ship to:        ${order.address || "—"}

ABOUT THE BUSINESS
${order.description || "—"}

NOTES
${order.notes || "—"}

---
Reply straight to this email to send them a quote.`;

  await sendEmail(env, {
    to: env.MAIL_WHOLESALE || env.MAIL_TO,
    from: env.MAIL_FROM,
    replyTo: order.email,
    subject: `Wholesale request — ${order.business || order.name} (${counted.total} units)`,
    text: summary
  });

  return json(request, { success: true });
}


/* =========================================================
   CONTACT FORM
   One form on the homepage, sorted into inboxes by topic.
========================================================= */

/* Which setting each topic gets mailed to. Any inbox you
   haven't set up falls back to MAIL_TO. */
const CONTACT_INBOX = {
  "Color request":      "MAIL_COLORS",
  "Order question":     "MAIL_QUESTIONS",
  "Return or exchange": "MAIL_RETURNS",
  "Wholesale":          "MAIL_WHOLESALE",
  "Something else":     "MAIL_QUESTIONS"
};


async function handleContact(request, env) {

  const form = await request.formData().catch(() => null);

  if (!form) {
    return json(request, { success: false, error: "Couldn't read the form." }, 400);
  }

  /* Spam trap. */
  if (clean(form.get("website"), 200)) {
    return json(request, { success: true });
  }

  const get = (name, max = 500) => clean(form.get(name), max);

  const name = get("name", 120);
  const email = get("email", 160);
  const topic = get("topic", 60) || "Something else";
  const color = get("color", 80);
  const order = get("order", 80);
  const message = get("message", 2000);

  if (!name || !isEmail(email)) {
    return json(request, { success: false, error: "Please enter your name and a valid email." }, 400);
  }

  if (!color && !message) {
    return json(request, { success: false, error: "Tell us a little about what you need." }, 400);
  }

  const inbox = env[CONTACT_INBOX[topic]] || env.MAIL_TO;

  const body =
`${topic.toUpperCase()}

From:   ${name}
Email:  ${email}
${color ? `Color:  ${color}\n` : ""}${order ? `Order:  ${order}\n` : ""}
MESSAGE
${message || "—"}

---
Reply straight to this email to answer them.`;

  await sendEmail(env, {
    to: inbox,
    from: env.MAIL_FROM,
    replyTo: email,
    subject: `${topic} — ${name}`,
    text: body
  });

  return json(request, { success: true });
}


/* Reads "Lite: 5 Black, 5 Red; XL: 2 Matte Black; Total: 12" */
function countUnits(text) {

  const result = { lite: 0, xl: 0, total: 0 };
  if (!text) return result;

  text
    .replace(/Total:\s*\d+/i, "")        // don't count the total twice
    .split(";")
    .forEach(part => {

      const numbers = (part.match(/\d+/g) || [])
        .reduce((sum, n) => sum + parseInt(n, 10), 0);

      if (/lite/i.test(part)) result.lite += numbers;
      else if (/xl/i.test(part)) result.xl += numbers;
      else result.total += numbers;      // anything unlabeled still counts
    });

  result.total += result.lite + result.xl;
  return result;
}


/* =========================================================
   SENDING THE EMAIL
   Cloudflare has two versions of the email binding. This tries
   the newer one first and falls back to the older raw one, so
   it works either way.
========================================================= */

async function sendEmail(env, message) {

  if (!env.EMAIL || !message.to || !message.from) {
    throw new Error("Email binding or MAIL_TO / MAIL_FROM is missing.");
  }

  try {
    await env.EMAIL.send({
      to: message.to,
      from: message.from,
      replyTo: message.replyTo,
      subject: message.subject,
      text: message.text
    });
    return;

  } catch (error) {
    console.log("Simple send failed, trying raw message:", error.message);
  }

  const { EmailMessage } = await import("cloudflare:email");

  await env.EMAIL.send(
    new EmailMessage(message.from, message.to, buildRawEmail(message))
  );
}


function buildRawEmail(message) {

  const headers = [
    `From: TwistMode Wholesale <${message.from}>`,
    `To: <${message.to}>`,
    message.replyTo ? `Reply-To: <${message.replyTo}>` : null,
    `Message-ID: <${crypto.randomUUID()}@shoptwistmode.com>`,
    `Date: ${new Date().toUTCString()}`,
    `Subject: ${message.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit"
  ].filter(Boolean);

  return headers.join("\r\n") + "\r\n\r\n" + message.text.replace(/\n/g, "\r\n");
}


/* =========================================================
   HELPERS
========================================================= */

function formatWeight(ounces) {
  if (ounces <= 0) return "—";
  if (ounces < 16) return `${ounces} oz`;
  const pounds = Math.floor(ounces / 16);
  const rest = ounces % 16;
  return `${pounds} lb${rest ? ` ${rest} oz` : ""} (${ounces} oz)`;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function clean(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);
}

/* Turns { a: { b: [ { c: 1 } ] } } into a[b][0][c]=1 — the shape Stripe's API wants. */
function toForm(object) {
  const pairs = [];
  (function walk(value, prefix) {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${prefix}[${index}]`));
    } else if (typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => walk(item, prefix ? `${prefix}[${key}]` : key));
    } else {
      pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    }
  })(object, "");
  return pairs.join("&");
}

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(request) }
  });
}
