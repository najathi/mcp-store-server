import type { Db } from './db.js';

/**
 * Sample data for "Harbor & Bean", a fictional online coffee shop.
 * Seeding is deterministic: the same reference date always produces the same orders,
 * which keeps tests and demos reproducible. All people and contact details are fake.
 */

export const CATEGORIES = ['Coffee', 'Tea', 'Brewing Gear', 'Mugs & Cups', 'Gift Sets'] as const;
type Category = (typeof CATEGORIES)[number];

// [sku, name, category, price (cents), stock, reorder level]
type ProductRow = [string, string, Category, number, number, number];

const PRODUCTS: ProductRow[] = [
  ['COF-001', 'Ethiopia Yirgacheffe Whole Bean 250g', 'Coffee', 1450, 42, 15],
  ['COF-002', 'Colombia Huila Whole Bean 250g', 'Coffee', 1300, 8, 15],
  ['COF-003', 'Guatemala Antigua Ground 250g', 'Coffee', 1250, 27, 12],
  ['COF-004', 'Sumatra Mandheling Whole Bean 1kg', 'Coffee', 4200, 5, 6],
  ['COF-005', 'House Espresso Blend 500g', 'Coffee', 2100, 63, 20],
  ['COF-006', 'Decaf Swiss Water Mexico 250g', 'Coffee', 1350, 0, 8],
  ['COF-007', 'Kenya AA Peaberry 250g', 'Coffee', 1650, 14, 10],
  ['TEA-001', 'Darjeeling First Flush 100g', 'Tea', 1800, 22, 8],
  ['TEA-002', 'Japanese Sencha 100g', 'Tea', 1500, 6, 8],
  ['TEA-003', 'Earl Grey Lavender 100g', 'Tea', 1100, 31, 10],
  ['TEA-004', 'Rooibos Vanilla 100g', 'Tea', 950, 18, 10],
  ['TEA-005', 'Ceremonial Matcha 30g', 'Tea', 2400, 3, 5],
  ['GEAR-001', 'Pour-Over Dripper (Ceramic)', 'Brewing Gear', 2800, 12, 5],
  ['GEAR-002', 'Gooseneck Kettle 1L', 'Brewing Gear', 6500, 4, 4],
  ['GEAR-003', 'Burr Grinder Hand Mill', 'Brewing Gear', 8900, 9, 3],
  ['GEAR-004', 'French Press 800ml', 'Brewing Gear', 3400, 16, 6],
  ['GEAR-005', 'Paper Filters #2 (100 pack)', 'Brewing Gear', 600, 120, 40],
  ['GEAR-006', 'Digital Coffee Scale', 'Brewing Gear', 3900, 2, 4],
  ['GEAR-007', 'Cold Brew Bottle 1L', 'Brewing Gear', 2900, 11, 5],
  ['MUG-001', 'Stoneware Mug 350ml (Harbor Blue)', 'Mugs & Cups', 1800, 35, 12],
  ['MUG-002', 'Double-Wall Glass Cup 250ml', 'Mugs & Cups', 1600, 9, 10],
  ['MUG-003', 'Travel Tumbler 470ml', 'Mugs & Cups', 2600, 21, 8],
  ['MUG-004', 'Espresso Cup Set (2)', 'Mugs & Cups', 2200, 13, 6],
  ['MUG-005', 'Enamel Camp Mug', 'Mugs & Cups', 1400, 0, 6],
  ['MUG-006', 'Latte Bowl 400ml', 'Mugs & Cups', 1900, 17, 6],
  ['GIFT-001', 'Coffee Discovery Box (4 x 100g)', 'Gift Sets', 3600, 10, 5],
  ['GIFT-002', 'Tea Sampler Tin Set', 'Gift Sets', 3200, 7, 5],
  ['GIFT-003', 'Pour-Over Starter Kit', 'Gift Sets', 7400, 4, 3],
  ['GIFT-004', 'Gift Card $50', 'Gift Sets', 5000, 999, 50],
  ['GIFT-005', 'Barista Apron (Canvas)', 'Gift Sets', 3000, 14, 4],
];

// [name, city]
const CUSTOMERS: [string, string][] = [
  ['Ava Thompson', 'Portland'],
  ['Liam Carter', 'Austin'],
  ['Maya Patel', 'Seattle'],
  ['Noah Kim', 'Denver'],
  ['Sofia Martinez', 'San Diego'],
  ['Ethan Brooks', 'Chicago'],
  ['Zara Ahmed', 'Boston'],
  ['Lucas Silva', 'Miami'],
  ['Hannah Lee', 'Minneapolis'],
  ['Omar Haddad', 'Detroit'],
  ['Grace Wilson', 'Nashville'],
  ['Kenji Watanabe', 'San Francisco'],
  ['Amara Okafor', 'Atlanta'],
  ['Felix Novak', 'Pittsburgh'],
  ['Isla Murphy', 'Philadelphia'],
  ['Ravi Shah', 'Phoenix'],
  ['Chloe Dubois', 'New Orleans'],
  ['Mateo Rossi', 'Sacramento'],
  ['Leah Cohen', 'Baltimore'],
  ['Yusuf Demir', 'Columbus'],
];

const ORDER_COUNT = 60;
const DAYS_OF_HISTORY = 60;
const FIRST_ORDER_ID = 1001;

/** Small deterministic PRNG (mulberry32) so seeded data is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickStatus(daysAgo: number, roll: number): string {
  if (roll < 0.06) return 'cancelled';
  if (roll < 0.1) return 'refunded';
  if (daysAgo <= 2) return 'paid';
  if (daysAgo <= 7) return 'shipped';
  return 'delivered';
}

export interface SeedSummary {
  products: number;
  customers: number;
  orders: number;
}

/**
 * Replaces all store data with the sample data set. Orders are spread over the
 * {@link DAYS_OF_HISTORY} days before `referenceDate` (default: now).
 * The audit log is cleared too, since it would refer to data that no longer exists.
 */
export function seedDatabase(db: Db, referenceDate: Date = new Date()): SeedSummary {
  const random = prng(20260101);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

  const insertProduct = db.prepare(
    `INSERT INTO products (sku, name, category, price_cents, stock, reorder_level)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertCustomer = db.prepare(
    `INSERT INTO customers (name, email, phone, city, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertOrder = db.prepare(
    `INSERT INTO orders (id, customer_id, status, created_at, total_cents) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?)`,
  );

  const run = db.transaction(() => {
    db.exec(
      'DELETE FROM order_items; DELETE FROM orders; DELETE FROM customers; DELETE FROM products; DELETE FROM audit_log;',
    );

    const productIds = PRODUCTS.map((p) => Number(insertProduct.run(...p).lastInsertRowid));
    // The gift card is never part of seeded orders, so it does not skew sales figures.
    const orderableProducts = productIds
      .map((id, index) => ({ id, price: PRODUCTS[index]![3], sku: PRODUCTS[index]![0] }))
      .filter((p) => p.sku !== 'GIFT-004');

    const customerIds = CUSTOMERS.map(([name, city], index) => {
      const [first, last] = name.toLowerCase().split(' ');
      const email = `${first}.${last}@example.com`;
      // 555-01xx numbers are reserved for fiction in the North American numbering plan.
      const phone = `+1-555-01${String(index).padStart(2, '0')}`;
      const joined = new Date(referenceDate.getTime() - (120 + index * 3) * 86_400_000);
      return Number(
        insertCustomer.run(name, email, phone, city, joined.toISOString()).lastInsertRowid,
      );
    });

    for (let i = 0; i < ORDER_COUNT; i++) {
      const orderId = FIRST_ORDER_ID + i;
      // Spread orders evenly over the history window, oldest first, with some jitter.
      const daysAgo = Math.round(DAYS_OF_HISTORY - (i * DAYS_OF_HISTORY) / ORDER_COUNT);
      const createdAt = new Date(
        referenceDate.getTime() - daysAgo * 86_400_000 - int(0, 12 * 60) * 60_000,
      );
      const customerId = customerIds[int(0, customerIds.length - 1)]!;
      const status = pickStatus(daysAgo, random());

      const lines = new Map<number, { quantity: number; price: number }>();
      const lineCount = int(1, 4);
      while (lines.size < lineCount) {
        const product = orderableProducts[int(0, orderableProducts.length - 1)]!;
        lines.set(product.id, { quantity: int(1, 3), price: product.price });
      }
      const total = [...lines.values()].reduce((sum, l) => sum + l.quantity * l.price, 0);

      insertOrder.run(orderId, customerId, status, createdAt.toISOString(), total);
      for (const [productId, line] of lines) {
        insertItem.run(orderId, productId, line.quantity, line.price);
      }
    }
  });
  run();

  return { products: PRODUCTS.length, customers: CUSTOMERS.length, orders: ORDER_COUNT };
}
