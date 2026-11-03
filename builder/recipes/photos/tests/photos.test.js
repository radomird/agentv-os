// The photo browser recipe's own tests. The test run gives the app one
// source with a few photos in two folders.

test("it reads the box's photos through the kit, and shows one", async (t) => {
  await t.frames(30);
  for (let i = 0; i < 6 && t.calls("photos.image") === 0; i++) {
    await t.press("ok");
    await t.wait(300);
  }
  t.ok(t.calls("photos.sources") > 0, "it asks for the sources");
  t.ok(t.calls("photos.list") > 0, "it lists a folder");
  t.ok(t.calls("photos.image") > 0, "it asks for a photo");
  t.ok(t.calls("photos.image", (args) => Number(args[1]) > 0) > 0, "at the width it shows it");
});

test("the arrows move, and Back leaves within a few presses", async (t) => {
  await t.press("right");
  await t.press("down");
  await t.frames(10);
  t.equal(t.errors(), [], "nothing threw");
  let left = false;
  for (let i = 0; i < 5 && !left; i++) left = !(await t.back());
  t.ok(left, "Back comes back up and leaves");
});
