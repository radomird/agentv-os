// Draws the menu once the page has loaded, as many sites do.
window.addEventListener("load", () => {
  const nav = document.createElement("nav");
  nav.id = "menu";
  nav.innerHTML = '<a href="/films">Films</a><a href="/series">Series</a>';
  document.body.prepend(nav);
});
