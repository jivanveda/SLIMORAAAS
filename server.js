require('dotenv').config();
// node-fetch v2 for server-side requests (npm install node-fetch@2)
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Live Visitor Store (in-memory) ──────────────────────────────────────────
const visitors = new Map(); // visitorId → lastSeen (ms timestamp)

// Auto-expire stale sessions every 30s
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of visitors) {
    if (now - ts > 60000) visitors.delete(id); // expire after 60s of silence
  }
}, 30000);

// ─── MongoDB Connection ────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ─── Schemas & Models ─────────────────────────────────────────────────────────
const orderSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  phone:       { type: String, required: true },
  address:     { type: String, required: true },
  pincode:     { type: String, required: true },
  city:        { type: String, default: '' },
  state:       { type: String, default: '' },
  product:     { type: String, default: 'Sweat Belt Pro' },
  productName: { type: String, default: 'Sweat Belt Pro — Advanced Slimming Belt' },
  productId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  size:        { type: String, default: 'M' },
  quantity:    { type: Number, default: 1 },
  price:       { type: Number, default: 599 },
  totalAmount: { type: Number, default: 599 },
  status:      { type: String, enum: ['new','confirmed','shipped','delivered','cancelled'], default: 'new' },
  awb:         { type: String, default: '' },
  shippedAt:   { type: Date, default: null },
  createdAt:   { type: Date, default: Date.now }
});

// ─── Helper: normalize string fields (trim whitespace) ────────────────────────
function trimOrder(o) {
  ['name','phone','address','pincode','city','state','product','productName','size'].forEach(f => {
    if (typeof o[f] === 'string') o[f] = o[f].replace(/\s+/g,' ').trim();
  });
}

const productSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String },
  price:       { type: Number },
  mrp:         { type: Number },
  images:      [String],
  benefits:    [String],
  ingredients: { type: String },
  howToUse:    { type: String },
  stock:       { type: Number, default: 100 },
  active:      { type: Boolean, default: true },
  createdAt:   { type: Date, default: Date.now }
});

const settingSchema = new mongoose.Schema({
  metaPixel: { type: String, default: '' }
});

const Order   = mongoose.model('Order',   orderSchema);
const Product = mongoose.model('Product', productSchema);
const Setting = mongoose.model('Setting', settingSchema);

const testimonialSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  location:  { type: String, default: 'India' },
  rating:    { type: Number, default: 5, min: 1, max: 5 },
  review:    { type: String, required: true },
  videoUrl:  { type: String, default: '' },
  thumbnail: { type: String, default: '' },
  active:    { type: Boolean, default: true },
}, { timestamps: true });
const Testimonial = mongoose.model('Testimonial', testimonialSchema);

// ─── Helper ───────────────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/orders — Create order (with duplicate phone check)
app.post('/api/orders', async (req, res) => {
  try {
    const phone = (req.body.phone || '').trim();

    // ── Duplicate phone check ──────────────────────────────────────────────
    if (phone) {
      const existing = await Order.findOne({ phone });
      if (existing) {
        return res.status(409).json({
          success: false,
          duplicate: true,
          error: 'An order with this phone number already exists.',
          existingOrderId: existing._id
        });
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    const body = req.body;
    ['name','phone','address','pincode','city','state'].forEach(f => { if(typeof body[f]==='string') body[f]=body[f].replace(/\s+/g,' ').trim(); });
    const order = new Order(body);
    await order.save();
    res.json({ success: true, orderId: order._id });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// GET /api/orders/export/csv — MUST come before /api/orders/:id routes
app.get('/api/orders/export/csv', async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    const headers = ['ID','Name','Phone','Address','Pincode','City','State','Product','Size','Qty','Price','Total','Status','AWB','ShippedAt','Date'];
    const rows = orders.map(o => [
      o._id,
      `"${(o.name||'').replace(/"/g,'""')}"`,
      o.phone,
      `"${(o.address||'').replace(/"/g,'""')}"`,
      o.pincode,
      o.city || '',
      o.state || '',
      `"${(o.productName||'').replace(/"/g,'""')}"`,
      o.size || '',
      o.quantity,
      o.price,
      o.totalAmount,
      o.status,
      o.awb || '',
      o.shippedAt ? new Date(o.shippedAt).toLocaleString('en-IN') : '',
      new Date(o.createdAt).toLocaleString('en-IN')
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="sweatbelt-orders.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/orders — All orders
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json({ success: true, orders });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/orders/:id/ship — mark as shipped with AWB number
app.put('/api/orders/:id/ship', async (req, res) => {
  try {
    const { awb } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status: 'shipped', awb: awb || '', shippedAt: new Date() },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, order });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// PUT /api/orders/:id/status — Update status
app.put('/api/orders/:id/status', async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, order });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// DELETE /api/orders/:id — Delete order
app.delete('/api/orders/:id', async (req, res) => {
  try {
    await Order.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/products — Active products only
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find({ active: true });
    res.json({ success: true, products });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/products/all — All products
app.get('/api/products/all', async (req, res) => {
  try {
    const products = await Product.find();
    res.json({ success: true, products });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/products — Create product
app.post('/api/products', async (req, res) => {
  try {
    const product = new Product(req.body);
    await product.save();
    res.json({ success: true, product });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// PUT /api/products/:id — Update product
app.put('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    res.json({ success: true, product });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// DELETE /api/products/:id — Delete product
app.delete('/api/products/:id', async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USER &&
    password === process.env.ADMIN_PASS
  ) {
    res.json({ success: true, token: 'sweatbelt_admin_token_' + Date.now() });
  } else {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/stats', async (req, res) => {
  try {
    const [total, newOrders, confirmed, shipped, revenueAgg] = await Promise.all([
      Order.countDocuments(),
      Order.countDocuments({ status: 'new' }),
      Order.countDocuments({ status: 'confirmed' }),
      Order.countDocuments({ status: 'shipped' }),
      Order.aggregate([
        { $match: { status: { $in: ['confirmed','shipped','delivered'] } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } }
      ])
    ]);
    res.json({
      success: true,
      totalOrders:      total,
      newOrders:        newOrders,
      confirmedOrders:  confirmed,
      shippedOrders:    shipped,
      revenue:          revenueAgg[0]?.total || 0
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PINCODE
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/pincode/:pin', async (req, res) => {
  try {
    const raw = await fetchUrl(`https://api.postalpincode.in/pincode/${req.params.pin}`);
    const parsed = JSON.parse(raw);
    res.json({ success: true, data: parsed });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEED
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/seed', async (req, res) => {
  try {
    const count = await Product.countDocuments();
    if (count > 0) return res.json({ success: true, message: 'Products already seeded' });
    const product = new Product({
      name:        'Sweat Belt Pro — Advanced Slimming Belt',
      description: 'Premium neoprene slimming belt that boosts core temperature for accelerated fat burning. Supports lower back and improves posture during workouts and daily activities.',
      price:       599,
      mrp:         1299,
      images:      [
        'https://m.media-amazon.com/images/I/61VH6ksMYXL._SY741_.jpg'
      ],
      benefits: [
        'Reduces belly fat & waist inches',
        'Increases sweating for faster fat burn',
        'Supports lower back & improves posture',
        'Comfortable neoprene material — fits all sizes',
        'Wear during workout, walking, or daily activities',
        'Results visible in 2–4 weeks with regular use'
      ],
      ingredients: 'Premium Neoprene, Velcro Fastener, Nylon',
      howToUse:    'Wrap tightly around your waist/belly area. Wear for 45–60 minutes during exercise or daily activities. Use daily for best results.',
      stock:       100,
      active:      true
    });
    await product.save();
    res.json({ success: true, message: 'Seeded successfully', product });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// META PIXEL
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/meta', async (req, res) => {
  try {
    const setting = await Setting.findOne();
    res.json({ success: true, metaPixel: setting?.metaPixel || '' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/meta', async (req, res) => {
  try {
    const { metaPixel } = req.body;
    let setting = await Setting.findOne();
    if (setting) {
      setting.metaPixel = metaPixel;
      await setting.save();
    } else {
      setting = new Setting({ metaPixel });
      await setting.save();
    }
    res.json({ success: true, metaPixel: setting.metaPixel });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SELLOSHIP PROXY
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/selloship/auth — get auth token from username + password
app.post('/api/selloship/auth', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: 'username and password required' });
  try {
    const response = await fetch('https://selloship.com/api/lock_actvs/channels/authToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await response.json();
    // Token may be in data.token, data.authToken, data.data.token, etc.
    const token = data.token || data.authToken || data.data?.token || data.data?.authToken || '';
    if (response.ok && token) {
      res.json({ success: true, token, raw: data });
    } else {
      res.json({ success: false, error: data.message || data.error || 'Auth failed', raw: data });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: 'Proxy error: ' + e.message });
  }
});

// POST /api/selloship/waybill — create waybill/shipment
app.post('/api/selloship/waybill', async (req, res) => {
  const { token, payload } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'token required' });
  if (!payload) return res.status(400).json({ success: false, error: 'payload required' });
  try {
    const response = await fetch('https://selloship.com/api/lock_actvs/channels/waybill', {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    // AWB may be in various locations depending on Selloship response
    const awb = data.waybill || data.awbNumber || data.awb_number || data.awb ||
                data.data?.waybill || data.data?.awbNumber || data.data?.awb || '';
    if (response.ok && (data.status === 'success' || data.success || awb)) {
      res.json({ success: true, awb, raw: data });
    } else {
      res.json({ success: false, error: data.message || data.error || 'Waybill creation failed', raw: data });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: 'Proxy error: ' + e.message });
  }
});

// PUT /api/orders/:id/address — AI-fixed address update
app.put('/api/orders/:id/address', async (req, res) => {
  try {
    const { name, address, city, state, pincode } = req.body;
    const fields = {};
    if (name)    fields.name    = name.replace(/\s+/g,' ').trim();
    if (address) fields.address = address.replace(/\s+/g,' ').trim();
    if (city)    fields.city    = city.replace(/\s+/g,' ').trim();
    if (state)   fields.state   = state.replace(/\s+/g,' ').trim();
    if (pincode) fields.pincode = pincode.trim();
    const order = await Order.findByIdAndUpdate(req.params.id, fields, { new: true });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, order });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// POST /api/admin/junk-clean — trim whitespace in all orders, flush stale data
app.post('/api/admin/junk-clean', async (req, res) => {
  try {
    // 1. Expire stale visitor sessions
    const visitorsBefore = visitors.size;
    const now = Date.now();
    for (const [id, ts] of visitors) {
      if (now - ts > 60000) visitors.delete(id);
    }
    const visitorsCleared = visitorsBefore - visitors.size;

    // 2. Find and trim whitespace in all order string fields
    const orders = await Order.find();
    let ordersFixed = 0;
    for (const order of orders) {
      let changed = false;
      ['name','phone','address','pincode','city','state','product','productName','size'].forEach(f => {
        if (typeof order[f] === 'string') {
          const trimmed = order[f].replace(/\s+/g,' ').trim();
          if (trimmed !== order[f]) { order[f] = trimmed; changed = true; }
        }
      });
      if (changed) { await order.save(); ordersFixed++; }
    }

    // 3. Remove junk orders (missing name AND missing phone)
    const junkResult = await Order.deleteMany({ name: { $in: ['', null] }, phone: { $in: ['', null] } });
    const emptyOrders = junkResult.deletedCount;

    res.json({ success: true, visitors: visitorsCleared, ordersFixed, emptyOrders });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE VISITORS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/visitors/ping — client sends arrive / heartbeat / leave
app.post('/api/visitors/ping', (req, res) => {
  const { visitorId, action } = req.body;
  if (!visitorId) return res.json({ success: false });
  if (action === 'leave') {
    visitors.delete(visitorId);
  } else {
    visitors.set(visitorId, Date.now());
  }
  res.json({ success: true, count: visitors.size });
});

// GET /api/visitors/count — admin polls this for real live count
app.get('/api/visitors/count', (req, res) => {
  const now = Date.now();
  for (const [id, ts] of visitors) {
    if (now - ts > 60000) visitors.delete(id);
  }
  res.json({ success: true, count: visitors.size });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TESTIMONIALS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/testimonials — public (for storefront)
app.get('/api/testimonials', async (req, res) => {
  try {
    const testimonials = await Testimonial.find({ active: true }).sort({ createdAt: -1 });
    res.json({ success: true, testimonials });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// GET /api/testimonials/all — admin (includes inactive)
app.get('/api/testimonials/all', async (req, res) => {
  try {
    const testimonials = await Testimonial.find().sort({ createdAt: -1 });
    res.json({ success: true, testimonials });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/testimonials — create
app.post('/api/testimonials', async (req, res) => {
  try {
    const t = new Testimonial(req.body);
    await t.save();
    res.json({ success: true, testimonial: t });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// PUT /api/testimonials/:id — update
app.put('/api/testimonials/:id', async (req, res) => {
  try {
    const t = await Testimonial.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!t) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, testimonial: t });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// DELETE /api/testimonials/:id — delete
app.delete('/api/testimonials/:id', async (req, res) => {
  try {
    await Testimonial.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
