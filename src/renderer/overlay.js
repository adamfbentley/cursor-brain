const overlayRoot = document.getElementById("overlayRoot");
const selectionBox = document.getElementById("selectionBox");
const overlayStatus = document.getElementById("overlayStatus");

let startPoint = null;
let isDragging = false;

function setSelectionBox(start, current) {
  const left = Math.min(start.x, current.x);
  const top = Math.min(start.y, current.y);
  const width = Math.abs(start.x - current.x);
  const height = Math.abs(start.y - current.y);

  selectionBox.style.display = "block";
  selectionBox.style.left = `${left}px`;
  selectionBox.style.top = `${top}px`;
  selectionBox.style.width = `${width}px`;
  selectionBox.style.height = `${height}px`;
}

overlayRoot.addEventListener("mousedown", (event) => {
  startPoint = { x: event.clientX, y: event.clientY };
  isDragging = true;
  overlayStatus.textContent = "Selection started...";
  setSelectionBox(startPoint, startPoint);
});

overlayRoot.addEventListener("mousemove", (event) => {
  if (!isDragging || !startPoint) {
    return;
  }
  setSelectionBox(startPoint, { x: event.clientX, y: event.clientY });
});

overlayRoot.addEventListener("mouseup", async (event) => {
  if (!isDragging || !startPoint) {
    return;
  }

  isDragging = false;
  const bounds = {
    x: startPoint.x,
    y: startPoint.y,
    width: event.clientX - startPoint.x,
    height: event.clientY - startPoint.y
  };

  overlayStatus.textContent = "Processing selection...";

  await window.assistant.processSelection({
    bounds,
    cursor: { x: event.screenX, y: event.screenY }
  });
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    window.close();
  }
});
