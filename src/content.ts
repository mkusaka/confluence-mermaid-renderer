import "./content.css";
import mermaid from "mermaid";

const CODE_BLOCK_SELECTORS = [
  '[data-testid="renderer-code-block"] code',
  "span[data-code-lang] code",
  ".code-block code",
  "code.language-text",
  "code.language-mermaid",
];

const PROCESSED_ATTR = "data-confluence-mermaid-renderer-state";
const SOURCE_ATTR = "data-confluence-mermaid-renderer-source";
const PREVIEW_ATTR = "data-confluence-mermaid-renderer-preview";
const SIDE_BY_SIDE_ATTR = "data-confluence-mermaid-renderer-side-by-side";
const ZOOM_ATTR = "data-confluence-mermaid-renderer-zoom";
const RENDER_LAYOUT: RenderLayout = "below";
const SCAN_DEBOUNCE_MS = 250;
const MIN_ZOOM = 0.01;
const ZOOM_LEVELS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const FIT_WIDTH_MARGIN_PX = 4;
const FIT_HEIGHT_MARGIN_PX = 4;
const FIT_MAX_VIEWPORT_HEIGHT_RATIO = 0.7;
const FIT_MAX_VIEWPORT_HEIGHT_PX = 720;
const ZOOM_EPSILON = 0.001;

type RenderLayout = "below" | "side-by-side";
type RenderState = "pending" | "rendered" | "error" | "ignored";

type SvgBaseSize = {
  height: number;
  width: number;
};

type PreviewFrame = {
  canvas: HTMLElement;
  preview: HTMLElement;
  resetButton: HTMLButtonElement;
  viewport: HTMLElement;
  zoomInButton: HTMLButtonElement;
  currentZoom: number;
  fitZoom: number;
  zoomLabel: HTMLElement;
  zoomOutButton: HTMLButtonElement;
};

let renderCounter = 0;
let scanTimer: number | undefined;

mermaid.initialize({
  htmlLabels: false,
  startOnLoad: false,
  securityLevel: "strict",
  flowchart: {
    diagramPadding: 12,
    useMaxWidth: false,
  },
});

export function findCodeBlocks(root: ParentNode = document): HTMLElement[] {
  const codeBlocks = new Set<HTMLElement>();

  for (const selector of CODE_BLOCK_SELECTORS) {
    for (const element of root.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      if (element.closest(`[${PREVIEW_ATTR}]`)) {
        continue;
      }

      codeBlocks.add(element);
    }
  }

  return [...codeBlocks];
}

export function getCodeText(codeElement: HTMLElement): string {
  return codeElement.textContent?.trim() ?? "";
}

export async function isMermaidSource(source: string): Promise<boolean> {
  const normalizedSource = source.trim();

  if (!normalizedSource || normalizedSource.length < 4) {
    return false;
  }

  if (!hasMermaidStartDirective(normalizedSource)) {
    return false;
  }

  try {
    const parseResult = await mermaid.parse(normalizedSource, {
      suppressErrors: true,
    });
    return parseResult !== false;
  } catch {
    return false;
  }
}

export async function renderMermaidBlock(
  codeElement: HTMLElement,
  layout: RenderLayout = RENDER_LAYOUT,
): Promise<void> {
  const source = getCodeText(codeElement);
  const sourceKey = stableSourceKey(source);
  const currentState = codeElement.getAttribute(
    PROCESSED_ATTR,
  ) as RenderState | null;

  if (currentState && codeElement.getAttribute(SOURCE_ATTR) === sourceKey) {
    if (
      currentState === "pending" ||
      currentState === "ignored" ||
      getExistingPreview(codeElement)
    ) {
      return;
    }
  }

  removeExistingPreview(codeElement);
  codeElement.setAttribute(PROCESSED_ATTR, "pending");
  codeElement.setAttribute(SOURCE_ATTR, sourceKey);

  if (!(await isMermaidSource(source))) {
    codeElement.setAttribute(PROCESSED_ATTR, "ignored");
    return;
  }

  const frame = createPreviewFrame();
  insertPreview(codeElement, frame.preview, layout);

  try {
    const renderId = `confluence-mermaid-renderer-${Date.now()}-${renderCounter++}`;
    const { svg } = await mermaid.render(renderId, source);

    frame.preview.classList.remove(
      "confluence-mermaid-renderer-preview--error",
    );
    frame.canvas.replaceChildren();
    frame.canvas.insertAdjacentHTML("afterbegin", svg);
    setupZoomControls(frame);
    codeElement.setAttribute(PROCESSED_ATTR, "rendered");
  } catch (error) {
    renderError(frame.preview, error);
    codeElement.setAttribute(PROCESSED_ATTR, "error");
  }
}

export function scanAndRender(root: ParentNode = document): void {
  for (const codeElement of findCodeBlocks(root)) {
    const source = getCodeText(codeElement);

    if (!hasMermaidStartDirective(source)) {
      continue;
    }

    void renderMermaidBlock(codeElement);
  }
}

export function observePageChanges(): MutationObserver {
  const observer = new MutationObserver((mutations) => {
    if (mutations.every(isExtensionMutation)) {
      return;
    }

    scheduleScan();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  return observer;
}

const MERMAID_START_PATTERNS: RegExp[] = [
  /^graph\s+(?:TB|TD|BT|RL|LR)\b/i,
  /^flowchart\s+(?:TB|TD|BT|RL|LR)\b/i,
  /^sequenceDiagram\b/,
  /^classDiagram(?:-v2)?\b/,
  /^stateDiagram(?:-v2)?\b/,
  /^erDiagram\b/,
  /^gantt\b/,
  /^journey\b/,
  /^pie(?:\s+(?:showData|title\b)|\b)/,
  /^mindmap\b/,
  /^timeline\b/,
  /^gitGraph\b/,
  /^requirementDiagram\b/,
  /^C4Context\b/,
];

function hasMermaidStartDirective(source: string): boolean {
  const firstMeaningfulLine = getFirstMeaningfulLine(source);

  if (!firstMeaningfulLine) {
    return false;
  }

  return MERMAID_START_PATTERNS.some((pattern) =>
    pattern.test(firstMeaningfulLine),
  );
}

function getFirstMeaningfulLine(source: string): string {
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    if (line.startsWith("%%")) {
      continue;
    }

    return line;
  }

  return "";
}

function getCodeBlockContainer(codeElement: HTMLElement): HTMLElement {
  return (
    codeElement.closest<HTMLElement>(".code-block") ??
    codeElement.closest<HTMLElement>('[data-testid="renderer-code-block"]') ??
    codeElement.closest<HTMLElement>("span[data-code-lang]") ??
    codeElement.closest<HTMLElement>("pre") ??
    codeElement
  );
}

function createPreviewFrame(): PreviewFrame {
  const preview = document.createElement("div");
  preview.className = "confluence-mermaid-renderer-preview";
  preview.setAttribute(PREVIEW_ATTR, "true");
  preview.setAttribute("aria-label", "Mermaid diagram preview");

  const toolbar = document.createElement("div");
  toolbar.className = "confluence-mermaid-renderer-toolbar";

  const zoomOutButton = createToolbarButton("-", "Zoom out Mermaid preview");
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "confluence-mermaid-renderer-zoom-label";
  zoomLabel.setAttribute("aria-live", "polite");

  const zoomInButton = createToolbarButton("+", "Zoom in Mermaid preview");
  const resetButton = createToolbarButton(
    "Fit",
    "Fit Mermaid preview to width",
  );

  toolbar.append(zoomOutButton, zoomLabel, zoomInButton, resetButton);

  const viewport = document.createElement("div");
  viewport.className = "confluence-mermaid-renderer-viewport";

  const canvas = document.createElement("div");
  canvas.className = "confluence-mermaid-renderer-canvas";
  viewport.append(canvas);

  preview.append(toolbar, viewport);
  enableDragPan(viewport);

  return {
    canvas,
    currentZoom: 1,
    fitZoom: 1,
    preview,
    resetButton,
    viewport,
    zoomInButton,
    zoomLabel,
    zoomOutButton,
  };
}

function createToolbarButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "confluence-mermaid-renderer-toolbar-button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);

  return button;
}

function insertPreview(
  codeElement: HTMLElement,
  preview: HTMLElement,
  layout: RenderLayout,
): void {
  const container = getCodeBlockContainer(codeElement);

  if (layout === "side-by-side") {
    insertSideBySidePreview(container, preview);
    return;
  }

  container.after(preview);
}

function insertSideBySidePreview(
  container: HTMLElement,
  preview: HTMLElement,
): void {
  if (container.parentElement?.hasAttribute(SIDE_BY_SIDE_ATTR)) {
    container.parentElement.append(preview);
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "confluence-mermaid-renderer-side-by-side";
  wrapper.setAttribute(SIDE_BY_SIDE_ATTR, "true");

  container.before(wrapper);
  wrapper.append(container, preview);
}

function removeExistingPreview(codeElement: HTMLElement): void {
  const preview = getExistingPreview(codeElement);

  if (!preview) {
    return;
  }

  const sideBySideContainer = preview.parentElement?.hasAttribute(
    SIDE_BY_SIDE_ATTR,
  )
    ? preview.parentElement
    : null;

  preview.remove();

  if (sideBySideContainer && sideBySideContainer.children.length === 1) {
    sideBySideContainer.before(
      sideBySideContainer.firstElementChild as Element,
    );
    sideBySideContainer.remove();
  }
}

function getExistingPreview(codeElement: HTMLElement): HTMLElement | null {
  const container = getCodeBlockContainer(codeElement);
  const sideBySideContainer = container.parentElement?.hasAttribute(
    SIDE_BY_SIDE_ATTR,
  )
    ? container.parentElement
    : null;

  if (sideBySideContainer) {
    return sideBySideContainer.querySelector<HTMLElement>(`[${PREVIEW_ATTR}]`);
  }

  const nextElement = container.nextElementSibling;

  if (
    nextElement instanceof HTMLElement &&
    nextElement.hasAttribute(PREVIEW_ATTR)
  ) {
    return nextElement;
  }

  return null;
}

function setupZoomControls(frame: PreviewFrame): void {
  const svg = frame.canvas.querySelector("svg");

  if (!(svg instanceof SVGSVGElement)) {
    return;
  }

  const baseSize = getSvgBaseSize(svg, frame.viewport);
  frame.fitZoom = getFitZoom(baseSize, frame.viewport);
  frame.currentZoom = frame.fitZoom;

  const applyCurrentZoom = (previousZoom: number = frame.currentZoom) => {
    const currentZoom = frame.currentZoom;
    const centerX = frame.viewport.scrollLeft + frame.viewport.clientWidth / 2;
    const centerY = frame.viewport.scrollTop + frame.viewport.clientHeight / 2;
    const scaleChange = currentZoom / previousZoom;

    frame.preview.setAttribute(ZOOM_ATTR, currentZoom.toString());
    frame.zoomLabel.textContent = getZoomLabel(currentZoom, frame.fitZoom);
    frame.zoomOutButton.disabled = currentZoom <= MIN_ZOOM + ZOOM_EPSILON;
    frame.zoomInButton.disabled =
      currentZoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1] - ZOOM_EPSILON;
    frame.resetButton.disabled = isSameZoom(currentZoom, frame.fitZoom);
    applySvgZoom(svg, currentZoom, baseSize);

    frame.viewport.scrollLeft =
      centerX * scaleChange - frame.viewport.clientWidth / 2;
    frame.viewport.scrollTop =
      centerY * scaleChange - frame.viewport.clientHeight / 2;
  };

  const setZoom = (nextZoom: number) => {
    const previousZoom = frame.currentZoom;
    frame.currentZoom = clampZoom(nextZoom);
    applyCurrentZoom(previousZoom);
  };

  frame.zoomOutButton.addEventListener("click", () => {
    setZoom(getPreviousZoom(frame.currentZoom));
  });

  frame.zoomInButton.addEventListener("click", () => {
    setZoom(getNextZoom(frame.currentZoom));
  });

  frame.resetButton.addEventListener("click", () => {
    setZoom(frame.fitZoom);
  });

  observeViewportResize(frame, baseSize, applyCurrentZoom);
  applyCurrentZoom(frame.fitZoom);
}

function observeViewportResize(
  frame: PreviewFrame,
  baseSize: SvgBaseSize,
  applyZoom: (previousZoom?: number) => void,
): void {
  let resizeFrame: number | undefined;

  const resizeObserver = new ResizeObserver(() => {
    if (resizeFrame !== undefined) {
      return;
    }

    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = undefined;

      if (!frame.preview.isConnected) {
        resizeObserver.disconnect();
        return;
      }

      const previousZoom = frame.currentZoom;
      const wasFit = isSameZoom(frame.currentZoom, frame.fitZoom);
      frame.fitZoom = getFitZoom(baseSize, frame.viewport);

      if (wasFit) {
        frame.currentZoom = frame.fitZoom;
      }

      applyZoom(previousZoom);
    });
  });

  resizeObserver.observe(frame.viewport);
}

function applySvgZoom(
  svg: SVGSVGElement,
  zoom: number,
  baseSize: SvgBaseSize,
): void {
  svg.setAttribute(
    "data-confluence-mermaid-renderer-base-width",
    baseSize.width.toString(),
  );
  svg.setAttribute(
    "data-confluence-mermaid-renderer-base-height",
    baseSize.height.toString(),
  );
  svg.style.width = `${Math.max(1, Math.round(baseSize.width * zoom))}px`;
  svg.style.height = `${Math.max(1, Math.round(baseSize.height * zoom))}px`;
  svg.style.maxWidth = "none";
}

function getFitZoom(baseSize: SvgBaseSize, viewport: HTMLElement): number {
  const availableWidth = Math.max(
    1,
    viewport.clientWidth - FIT_WIDTH_MARGIN_PX,
  );
  const availableHeight = Math.max(
    1,
    getAvailableFitHeight() - FIT_HEIGHT_MARGIN_PX,
  );
  const widthZoom = availableWidth / baseSize.width;
  const heightZoom = availableHeight / baseSize.height;

  return clampZoom(Math.min(1, widthZoom, heightZoom));
}

function getAvailableFitHeight(): number {
  return Math.min(
    FIT_MAX_VIEWPORT_HEIGHT_PX,
    Math.max(1, window.innerHeight * FIT_MAX_VIEWPORT_HEIGHT_RATIO),
  );
}

function getZoomLabel(zoom: number, fitZoom: number): string {
  const percentage = `${Math.round(zoom * 100)}%`;

  if (!isSameZoom(zoom, fitZoom)) {
    return percentage;
  }

  return zoom < 1 - ZOOM_EPSILON ? `Fit ${percentage}` : percentage;
}

function getPreviousZoom(currentZoom: number): number {
  for (let index = ZOOM_LEVELS.length - 1; index >= 0; index -= 1) {
    if (ZOOM_LEVELS[index] < currentZoom - ZOOM_EPSILON) {
      return ZOOM_LEVELS[index];
    }
  }

  return MIN_ZOOM;
}

function getNextZoom(currentZoom: number): number {
  for (const zoom of ZOOM_LEVELS) {
    if (zoom > currentZoom + ZOOM_EPSILON) {
      return zoom;
    }
  }

  return ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
}

function clampZoom(zoom: number): number {
  return Math.max(
    MIN_ZOOM,
    Math.min(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], zoom),
  );
}

function isSameZoom(left: number, right: number): boolean {
  return Math.abs(left - right) < ZOOM_EPSILON;
}

function getSvgBaseSize(
  svg: SVGSVGElement,
  viewport: HTMLElement,
): SvgBaseSize {
  const storedWidth = Number(
    svg.getAttribute("data-confluence-mermaid-renderer-base-width"),
  );
  const storedHeight = Number(
    svg.getAttribute("data-confluence-mermaid-renderer-base-height"),
  );

  if (
    Number.isFinite(storedWidth) &&
    storedWidth > 0 &&
    Number.isFinite(storedHeight) &&
    storedHeight > 0
  ) {
    return {
      height: storedHeight,
      width: storedWidth,
    };
  }

  const viewBox = svg.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
  const viewBoxWidth = viewBox?.[2];
  const viewBoxHeight = viewBox?.[3];

  if (
    viewBoxWidth &&
    Number.isFinite(viewBoxWidth) &&
    viewBoxWidth > 0 &&
    viewBoxHeight &&
    Number.isFinite(viewBoxHeight) &&
    viewBoxHeight > 0
  ) {
    return {
      height: viewBoxHeight,
      width: viewBoxWidth,
    };
  }

  const widthAttribute = parseSvgLength(svg.getAttribute("width"));
  const heightAttribute = parseSvgLength(svg.getAttribute("height"));

  if (widthAttribute && heightAttribute) {
    return {
      height: heightAttribute,
      width: widthAttribute,
    };
  }

  const rect = svg.getBoundingClientRect();

  return {
    height: heightAttribute || rect.height || viewport.clientHeight || 600,
    width: widthAttribute || rect.width || viewport.clientWidth || 800,
  };
}

function parseSvgLength(value: string | null): number | undefined {
  if (!value || value.endsWith("%")) {
    return undefined;
  }

  const parsedValue = Number.parseFloat(value);

  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : undefined;
}

function enableDragPan(viewport: HTMLElement): void {
  let dragState:
    | {
        pointerId: number;
        scrollLeft: number;
        scrollTop: number;
        startX: number;
        startY: number;
      }
    | undefined;

  const stopDragging = () => {
    if (!dragState) {
      return;
    }

    if (viewport.hasPointerCapture(dragState.pointerId)) {
      viewport.releasePointerCapture(dragState.pointerId);
    }

    dragState = undefined;
    viewport.classList.remove("confluence-mermaid-renderer-viewport--dragging");
  };

  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !isScrollable(viewport)) {
      return;
    }

    if (event.target instanceof Element && event.target.closest("button, a")) {
      return;
    }

    dragState = {
      pointerId: event.pointerId,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      startX: event.clientX,
      startY: event.clientY,
    };

    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("confluence-mermaid-renderer-viewport--dragging");
    event.preventDefault();
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!dragState) {
      return;
    }

    viewport.scrollLeft =
      dragState.scrollLeft - (event.clientX - dragState.startX);
    viewport.scrollTop =
      dragState.scrollTop - (event.clientY - dragState.startY);
    event.preventDefault();
  });

  viewport.addEventListener("pointerup", stopDragging);
  viewport.addEventListener("pointercancel", stopDragging);
  viewport.addEventListener("lostpointercapture", stopDragging);
}

function isScrollable(element: HTMLElement): boolean {
  return (
    element.scrollWidth > element.clientWidth ||
    element.scrollHeight > element.clientHeight
  );
}

function renderError(preview: HTMLElement, error: unknown): void {
  preview.classList.add("confluence-mermaid-renderer-preview--error");
  preview.replaceChildren();

  const title = document.createElement("p");
  title.className = "confluence-mermaid-renderer-error-title";
  title.textContent = "Mermaid render error";

  const message = document.createElement("pre");
  message.className = "confluence-mermaid-renderer-error-message";
  message.textContent = getErrorMessage(error);

  preview.append(title, message);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function scheduleScan(): void {
  if (scanTimer !== undefined) {
    window.clearTimeout(scanTimer);
  }

  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    scanAndRender();
  }, SCAN_DEBOUNCE_MS);
}

function isExtensionMutation(mutation: MutationRecord): boolean {
  const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];

  return changedNodes.length > 0 && changedNodes.every(isExtensionNode);
}

function isExtensionNode(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;

  return Boolean(element?.closest(`[${PREVIEW_ATTR}], [${SIDE_BY_SIDE_ATTR}]`));
}

function stableSourceKey(source: string): string {
  let hash = 0;

  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

observePageChanges();
scheduleScan();
