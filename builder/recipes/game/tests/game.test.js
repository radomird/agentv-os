// The game recipe's own tests, which every game built from it passes as
// well as its own. They run in the game's frame with AgenTV's test API.

test("the game listens to the buttons and to Back", async (t) => {
  await t.frames(10);
  const listening = t.listening();
  t.ok(listening.input > 0, "it takes its buttons from agentv.input.on");
  t.ok(listening.back, "it has its own Back, to pause in play");
});

test("the game said its first frame is drawn", async (t) => {
  t.ok(t.ready(), "it calls agentv.ready()");
});

test("a few presses of each button don't stop it", async (t) => {
  for (const button of ["ok", "left", "right", "up", "down", "x", "y", "start"]) {
    await t.press(button, { source: button.length > 1 && !["ok", "left", "right", "up", "down"].includes(button) ? "gamepad" : "remote" });
  }
  await t.frames(30);
  t.ok(!t.left(), "it's still running");
  t.equal(t.errors(), [], "nothing threw");
});

test("Back pauses or leaves, and leaves within three presses", async (t) => {
  await t.press("ok");
  let left = false;
  for (let i = 0; i < 3 && !left; i++) left = !(await t.back());
  t.ok(left, "Back leaves the game by the third press");
});
