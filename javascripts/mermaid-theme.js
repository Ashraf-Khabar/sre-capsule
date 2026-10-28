(function () {
  function vars(dark) {
    var shared = {
      fontFamily: "Roboto, Segoe UI, sans-serif",
      fontSize: "14px"
    };
    if (dark) {
      return Object.assign(shared, {
        background: "transparent",
        primaryColor: "#1e1b4b",
        primaryTextColor: "#f8fafc",
        primaryBorderColor: "#22d3ee",
        secondaryColor: "#312e81",
        secondaryTextColor: "#f8fafc",
        secondaryBorderColor: "#818cf8",
        tertiaryColor: "#0f172a",
        tertiaryTextColor: "#f8fafc",
        tertiaryBorderColor: "#38bdf8",
        lineColor: "#67e8f9",
        textColor: "#e7eef6",
        mainBkg: "#1e293b",
        nodeBorder: "#60a5fa",
        clusterBkg: "#172033",
        clusterBorder: "#3b82f6",
        titleColor: "#e7eef6",
        edgeLabelBackground: "#111827",
        actorBkg: "#1e293b",
        actorBorder: "#60a5fa",
        actorTextColor: "#e7eef6",
        signalColor: "#93c5fd",
        signalTextColor: "#e7eef6",
        labelBoxBkgColor: "#172033",
        labelBoxBorderColor: "#60a5fa",
        labelTextColor: "#e7eef6",
        loopTextColor: "#e7eef6",
        noteBkgColor: "#172033",
        noteTextColor: "#e7eef6",
        noteBorderColor: "#60a5fa",
        activationBkgColor: "#1e3a5f",
        activationBorderColor: "#60a5fa",
        sequenceNumberColor: "#0f172a"
      });
    }
    return Object.assign(shared, {
      background: "transparent",
        primaryColor: "#eef2ff",
        primaryTextColor: "#1e1b4b",
        primaryBorderColor: "#4f46e5",
        secondaryColor: "#ecfeff",
        secondaryTextColor: "#164e63",
        secondaryBorderColor: "#0891b2",
        tertiaryColor: "#f5f3ff",
        tertiaryTextColor: "#312e81",
        tertiaryBorderColor: "#7c3aed",
        lineColor: "#4f46e5",
      textColor: "#1e293b",
      mainBkg: "#e8eef8",
      nodeBorder: "#2563eb",
      clusterBkg: "#f8fafc",
      clusterBorder: "#2563eb",
      titleColor: "#0f172a",
      edgeLabelBackground: "#ffffff",
      actorBkg: "#e8eef8",
      actorBorder: "#2563eb",
      actorTextColor: "#1e293b",
      signalColor: "#2563eb",
      signalTextColor: "#1e293b",
      labelBoxBkgColor: "#ffffff",
      labelBoxBorderColor: "#2563eb",
      labelTextColor: "#1e293b",
      loopTextColor: "#1e293b",
      noteBkgColor: "#eff6ff",
      noteTextColor: "#1e293b",
      noteBorderColor: "#2563eb",
      activationBkgColor: "#dbeafe",
      activationBorderColor: "#2563eb",
      sequenceNumberColor: "#ffffff"
    });
  }

  function config() {
    var dark = document.body.getAttribute("data-md-color-scheme") === "slate";
    return {
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      look: "classic",
      themeVariables: vars(dark),
      flowchart: {
        curve: "basis",
        padding: 16,
        nodeSpacing: 36,
        rankSpacing: 48,
        htmlLabels: true,
        diagramPadding: 8
      },
      sequence: { actorMargin: 40, messageMargin: 28 }
    };
  }

  var seq = 0;

  function own(node) {
    if (!node || node.getAttribute("data-qc-owned")) return;
    var source = node.getAttribute("data-qc-source");
    if (!source) return;
    var text = (node.textContent || "").trim();
    if (text && text.charAt(0) !== "<" && !node.getAttribute("data-qc-pending")) return;
    var mine = document.createElement("div");
    mine.className = "mermaid";
    mine.setAttribute("data-qc-owned", "1");
    mine.setAttribute("data-qc-source", source);
    mine.setAttribute("tabindex", "0");
    mine.setAttribute("role", "button");
    mine.setAttribute("aria-label", "Open this diagram larger");
    node.replaceWith(mine);
    paint(mine, source);
  }

  async function paint(node, source) {
    if (!window.mermaid) return;
    mermaid.initialize(config());
    try {
      var drawn = await mermaid.render("qcDiag" + (++seq), source);
      var svgText = typeof drawn === "string" ? drawn : drawn.svg;
      if (!node.isConnected) return;
      node.innerHTML = svgText;
      var svg = node.querySelector("svg");
      if (!svg) return;
      svg.removeAttribute("width");
      svg.style.maxWidth = "100%";
      svg.style.height = "auto";
      dress(svg);
    } catch (err) {
      node.textContent = "This diagram could not be drawn.";
    }
  }

  function adopt(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.classList && node.classList.contains("mermaid")) own(node);
    if (node.querySelectorAll) node.querySelectorAll(".mermaid").forEach(own);
  }

  function dress(svg) {
    if (svg.getAttribute("data-qc-dressed") === "1") return;
    svg.setAttribute("data-qc-dressed", "1");
    var ns = "http://www.w3.org/2000/svg";
    var dark = document.body.getAttribute("data-md-color-scheme") === "slate";
    var uid = "qc" + Math.random().toString(36).slice(2, 8);
    var defs = svg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS(ns, "defs");
      svg.insertBefore(defs, svg.firstChild);
    }

    var grad = document.createElementNS(ns, "linearGradient");
    grad.setAttribute("id", uid + "fill");
    grad.setAttribute("x1", "0");
    grad.setAttribute("y1", "0");
    grad.setAttribute("x2", "1");
    grad.setAttribute("y2", "1");
    [["0%", dark ? "#312e81" : "#ffffff"], ["55%", dark ? "#1e1b4b" : "#eef2ff"], ["100%", dark ? "#155e75" : "#cffafe"]].forEach(function (stop) {
      var el = document.createElementNS(ns, "stop");
      el.setAttribute("offset", stop[0]);
      el.setAttribute("stop-color", stop[1]);
      grad.appendChild(el);
    });
    defs.appendChild(grad);

    var soft = document.createElementNS(ns, "filter");
    soft.setAttribute("id", uid + "soft");
    soft.setAttribute("x", "-20%");
    soft.setAttribute("y", "-20%");
    soft.setAttribute("width", "140%");
    soft.setAttribute("height", "140%");
    var blur = document.createElementNS(ns, "feDropShadow");
    blur.setAttribute("dx", "0");
    blur.setAttribute("dy", "6");
    blur.setAttribute("stdDeviation", "4");
    blur.setAttribute("flood-color", dark ? "#22d3ee" : "#4f46e5");
    blur.setAttribute("flood-opacity", dark ? "0.28" : "0.16");
    soft.appendChild(blur);
    defs.appendChild(soft);

    var stroke = dark ? "#67e8f9" : "#4f46e5";
    var fill = "url(#" + uid + "fill)";
    svg.querySelectorAll("g.cluster rect").forEach(function (rect) {
      rect.setAttribute("rx", "18");
      rect.setAttribute("ry", "18");
      rect.setAttribute("fill", dark ? "rgba(15,23,42,0.45)" : "rgba(255,255,255,0.55)");
      rect.setAttribute("stroke", dark ? "#818cf8" : "#a5b4fc");
      rect.setAttribute("stroke-dasharray", "6 5");
    });
    var shapes = svg.querySelectorAll(".node rect, .node polygon, .node circle, g.actor rect, .actor-box, .er.entityBox");
    shapes.forEach(function (shape, index) {
      if (shape.ownerSVGElement && shape.closest("g.cluster") && shape.parentNode && shape.parentNode.classList.contains("cluster")) return;
      if (shape.tagName.toLowerCase() === "rect") {
        shape.setAttribute("rx", "14");
        shape.setAttribute("ry", "14");
      }
      shape.setAttribute("fill", fill);
      shape.setAttribute("stroke", stroke);
      shape.setAttribute("stroke-width", "1.7");
      shape.setAttribute("filter", "url(#" + uid + "soft)");
      shape.style.animationDelay = (index * 0.06) + "s";
    });

    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var paths = svg.querySelectorAll("g.edgePath path, path.flowchart-link, path.messageLine0, path.messageLine1, path.relationshipLine, path.transition");
    var host = document.createElementNS(ns, "g");
    host.setAttribute("class", "qc-orbs");
    var count = 0;
    paths.forEach(function (path) {
      if (count >= 36) return;
      var d = path.getAttribute("d");
      if (!d) return;
      var id = uid + "p" + count;
      path.setAttribute("id", id);
      path.setAttribute("stroke", stroke);
      path.setAttribute("stroke-width", "2.15");
      path.setAttribute("class", (path.getAttribute("class") || "") + " qc-live-edge");
      [0, 0.45].forEach(function (lag, orbIndex) {
        var orb = document.createElementNS(ns, "circle");
        orb.setAttribute("class", "qc-orb");
        orb.setAttribute("r", orbIndex === 0 ? "4.6" : "2.6");
        orb.setAttribute("fill", dark ? "#a5f3fc" : "#22d3ee");
        orb.setAttribute("opacity", orbIndex === 0 ? "1" : "0.65");
        var motion = document.createElementNS(ns, "animateMotion");
        motion.setAttribute("dur", (1.7 + (count % 5) * 0.22) + "s");
        motion.setAttribute("repeatCount", "indefinite");
        motion.setAttribute("begin", (count * 0.12 + lag) + "s");
        motion.setAttribute("rotate", "auto");
        var mpath = document.createElementNS(ns, "mpath");
        mpath.setAttribute("href", "#" + id);
        mpath.setAttributeNS("http://www.w3.org/1999/xlink", "href", "#" + id);
        motion.appendChild(mpath);
        orb.appendChild(motion);
        host.appendChild(orb);
      });
      count += 1;
    });
    if (count) svg.appendChild(host);
  }

  function lightbox() {
    var box = document.querySelector(".qc-lightbox");
    if (box) return box;
    box = document.createElement("div");
    box.className = "qc-lightbox";
    box.hidden = true;
    box.innerHTML = '<button type="button" class="qc-lightbox__backdrop" aria-label="Close diagram"></button><div class="qc-lightbox__panel" role="dialog" aria-modal="true" aria-label="Diagram"><button type="button" class="qc-lightbox__close" aria-label="Close">×</button><div class="qc-lightbox__stage"></div></div>';
    document.body.appendChild(box);
    box.querySelector(".qc-lightbox__backdrop").addEventListener("click", closeLightbox);
    box.querySelector(".qc-lightbox__close").addEventListener("click", closeLightbox);
    return box;
  }

  function closeLightbox() {
    var box = document.querySelector(".qc-lightbox");
    if (!box || box.hidden) return;
    box.hidden = true;
    box.querySelector(".qc-lightbox__stage").textContent = "";
    document.body.classList.remove("qc-lightbox-open");
  }

  async function openLightbox(source) {
    if (!window.mermaid || !source) return;
    var box = lightbox();
    var stage = box.querySelector(".qc-lightbox__stage");
    stage.textContent = "Drawing…";
    box.hidden = false;
    document.body.classList.add("qc-lightbox-open");
    var large = config();
    large.themeVariables = Object.assign({}, large.themeVariables, { fontSize: "18px" });
    large.flowchart = Object.assign({}, large.flowchart, { padding: 22, nodeSpacing: 48, rankSpacing: 60 });
    mermaid.initialize(large);
    try {
      var drawn = await mermaid.render("qcLarge" + Date.now(), source);
      var svgText = typeof drawn === "string" ? drawn : drawn.svg;
      stage.innerHTML = svgText;
      var svg = stage.querySelector("svg");
      if (svg) {
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        dress(svg);
      }
    } catch (err) {
      stage.textContent = "This diagram could not be enlarged.";
    }
    mermaid.initialize(config());
    var closeBtn = box.querySelector(".qc-lightbox__close");
    if (closeBtn) closeBtn.focus();
  }

  function boot() {
    document.addEventListener("click", function (event) {
      var card = event.target.closest && event.target.closest(".mermaid");
      if (!card || card.closest(".qc-lightbox")) return;
      if (event.target.closest("a, button")) return;
      var source = card.getAttribute("data-qc-source");
      if (!source) return;
      openLightbox(source);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeLightbox();
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      var card = event.target.closest && event.target.closest(".mermaid");
      if (!card) return;
      event.preventDefault();
      var source = card.getAttribute("data-qc-source");
      if (source) openLightbox(source);
    });
    new MutationObserver(function (records) {
      records.forEach(function (rec) {
        rec.addedNodes.forEach(adopt);
      });
    }).observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll(".mermaid").forEach(own);
    if (window.document$ && typeof document$.subscribe === "function") {
      document$.subscribe(function () {
        closeLightbox();
        document.querySelectorAll(".mermaid").forEach(own);
      });
    }
    var last = document.body.getAttribute("data-md-color-scheme");
    new MutationObserver(function () {
      var now = document.body.getAttribute("data-md-color-scheme");
      if (now === last) return;
      last = now;
      document.querySelectorAll(".mermaid[data-qc-owned]").forEach(function (node) {
        var source = node.getAttribute("data-qc-source");
        if (source) paint(node, source);
      });
    }).observe(document.body, { attributes: true, attributeFilter: ["data-md-color-scheme"] });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
