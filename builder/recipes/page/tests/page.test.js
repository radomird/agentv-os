// What every page app passes, built from a plan: it listens to its buttons,
// says it's drawn, and Back leaves it.

test("it listens to the buttons, and says when it's drawn", async (t) => {
  await t.frames(10);
  t.ok(t.listening().input > 0, "it takes its buttons from agentv.input.on");
  t.ok(t.ready(), "it calls agentv.ready()");
});

test("nothing throws, and Back leaves within a few presses", async (t) => {
  await t.press("ok");
  await t.press("right");
  await t.frames(10);
  t.equal(t.errors(), [], "nothing threw");
  let left = false;
  for (let i = 0; i < 4 && !left; i++) left = !(await t.back());
  t.ok(left, "Back leaves the app");
});
