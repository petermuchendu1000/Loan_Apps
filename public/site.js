const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#site-nav");
const compactLayout = window.matchMedia("(max-width: 47rem)");

function setMenuOpen(isOpen) {
  menuButton.setAttribute("aria-expanded", String(isOpen));
  navigation.hidden = compactLayout.matches && !isOpen;
}

function syncMenu() {
  menuButton.hidden = !compactLayout.matches;
  setMenuOpen(false);
}

menuButton.addEventListener("click", () => {
  setMenuOpen(menuButton.getAttribute("aria-expanded") === "false");
});

navigation.addEventListener("click", (event) => {
  if (compactLayout.matches && event.target.closest("a")) {
    setMenuOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuButton.getAttribute("aria-expanded") === "true") {
    setMenuOpen(false);
    menuButton.focus();
  }
});

compactLayout.addEventListener("change", syncMenu);
syncMenu();
