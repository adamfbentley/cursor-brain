document.addEventListener("mousedown", async (event) => {
  if (event.button === 0) {
    await window.assistant.hideBubble();
  }
});

document.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
  },
  { passive: false }
);