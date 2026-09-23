(function initializeMoaBrand(globalScope) {
  "use strict";

  const namespace = globalScope.NotionFavoriteSections || {};
  const svgNamespace = "http://www.w3.org/2000/svg";
  const colors = Object.freeze({ ink: "#164C45", mint: "#A3D9C5", paper: "#F6F3EC" });
  // Vector production adaptation of the approved Moa bookmark + two-page concept.
  // One geometry source feeds the injected mark, popup SVG and Chrome PNG exports.
  const shapes = Object.freeze([
    Object.freeze({
      color: "ink",
      d: "M9 2H23C27.2 2 30 5.3 30 9.5V26.7C30 29.6 28.1 31 25.7 29.8L18.1 26C16.7 25.3 15.3 25.3 13.9 26L6.3 29.8C3.9 31 2 29.6 2 26.7V9.5C2 5.3 4.8 2 9 2Z"
    }),
    Object.freeze({
      color: "mint",
      d: "M12.8 5.8H22.2C24.5 5.8 26 7.2 26 9.5V17.7C26 19.1 25.4 20 24.2 20.6L22.6 21.4V14C22.6 11.9 21.4 10.5 19.3 10L10 7.8C10.3 6.5 11.3 5.8 12.8 5.8Z"
    }),
    Object.freeze({
      color: "paper",
      d: "M8.3 9.6L18.6 12.1C20.3 12.5 21 13.5 21 15.1V21.1C21 23 20 23.8 18.4 23.4L7.7 20.8C6.5 20.5 6 19.7 6 18.4V11.6C6 10 6.9 9.3 8.3 9.6Z"
    })
  ]);

  function createIcon(documentRef, { size = 16, className = "" } = {}) {
    const icon = documentRef.createElementNS(svgNamespace, "svg");
    for (const [key, value] of Object.entries({
      width: size, height: size, viewBox: "0 0 32 32", fill: "none",
      "aria-hidden": "true", focusable: "false", "data-moa-mark": ""
    })) icon.setAttribute(key, String(value));
    if (className) icon.setAttribute("class", className);
    for (const shape of shapes) {
      const path = documentRef.createElementNS(svgNamespace, "path");
      path.setAttribute("d", shape.d);
      path.setAttribute("fill", `var(--moa-${shape.color}, ${colors[shape.color]})`);
      icon.append(path);
    }
    return icon;
  }

  function toSvg({ tile = false } = {}) {
    const paths = shapes.map(shape => `<path fill="${colors[shape.color]}" d="${shape.d}"/>`).join("");
    const artwork = tile
      ? `<rect width="36" height="36" rx="8" fill="${colors.paper}"/><g transform="translate(2 2)">${paths}</g>`
      : paths;
    const extent = tile ? 36 : 32;
    return `<svg xmlns="${svgNamespace}" viewBox="0 0 ${extent} ${extent}" fill="none">${artwork}</svg>\n`;
  }

  namespace.brand = Object.freeze({ name: "FAVMOA", koreanName: "팹모아", colors, shapes, createIcon, toSvg });
  globalScope.NotionFavoriteSections = namespace;
})(globalThis);
