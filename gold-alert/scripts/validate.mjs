/**
 * Offline validation for auto-generate math and basic Worker helpers.
 * Run: node scripts/validate.mjs
 */

function roundPrice(p) {
  return Math.round(p * 100000) / 100000;
}

function autoGenerate(currentPrice, step) {
  const prices = [];
  for (let i = 5; i >= 1; i--) prices.push(roundPrice(currentPrice - step * i));
  for (let i = 1; i <= 5; i++) prices.push(roundPrice(currentPrice + step * i));
  return prices;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const p1 = autoGenerate(3978.25, 5);
assert(p1.length === 10, "expected 10 alerts");
assert(!p1.includes(3978.25), "must not include current price");
assert(p1[0] === 3953.25, `got ${p1[0]}`);
assert(p1[4] === 3973.25, `got ${p1[4]}`);
assert(p1[5] === 3983.25, `got ${p1[5]}`);
assert(p1[9] === 4003.25, `got ${p1[9]}`);

const p2 = autoGenerate(3978.25, 10);
assert(p2[0] === 3928.25, `step10 low got ${p2[0]}`);
assert(p2[9] === 4028.25, `step10 high got ${p2[9]}`);

// Cross logic (mirror EA)
function checkCross(prev, curr, ap, side) {
  // returns { fire: 'UP'|'DOWN'|null, side }
  if (prev < ap && curr >= ap) {
    if (side <= 0) return { fire: "UP", side: 1 };
    return { fire: null, side: 1 };
  }
  if (prev > ap && curr <= ap) {
    if (side >= 0) return { fire: "DOWN", side: -1 };
    return { fire: null, side: -1 };
  }
  if (curr < ap) return { fire: null, side: -1 };
  if (curr > ap) return { fire: null, side: 1 };
  return { fire: null, side };
}

let side = -1; // below 3983.25
let r = checkCross(3980, 3984, 3983.25, side);
assert(r.fire === "UP", "expect UP");
side = r.side;
r = checkCross(3984, 3985, 3983.25, side);
assert(r.fire === null, "no repeat while above");
r = checkCross(3985, 3982, 3983.25, side);
assert(r.fire === "DOWN", "expect DOWN on re-cross");
side = r.side;
r = checkCross(3982, 3981, 3983.25, side);
assert(r.fire === null, "no repeat while below");
r = checkCross(3981, 3984, 3983.25, side);
assert(r.fire === "UP", "expect UP again after re-cross");

console.log("OK: all validate.mjs checks passed");
