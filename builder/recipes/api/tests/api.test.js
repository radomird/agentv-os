// The public API recipe's own tests: the app reaches only what it declared
// and sets its tile.

test("it reaches the API it declared, and nothing else", async (t) => {
  await t.wait(3000);
  t.ok(t.requests().length > 0, "it asks its API for something");
  t.equal(t.requests().filter((r) => !r.declared), [], "every request is to a declared origin");
});

test("it shows something on its tile", async (t) => {
  await t.wait(3000);
  t.ok(t.tile() !== null, "it sets its tile with agentv.tile.set");
});

test("Back leaves within a few presses", async (t) => {
  let left = false;
  for (let i = 0; i < 4 && !left; i++) left = !(await t.back());
  t.ok(left, "Back comes back up and leaves");
});
