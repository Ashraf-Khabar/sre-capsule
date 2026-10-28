(function () {
  function vars(dark) {
    var shared = {
      fontFamily: "Roboto, Segoe UI, sans-serif",
      fontSize: "14px"
    };
    if (dark) {
      return Object.assign(shared, {
        background: "transparent",
        primaryColor: "#1e293b",
        primaryTextColor: "#e7eef6",
        primaryBorderColor: "#60a5fa",
        secondaryColor: "#172033",
        secondaryTextColor: "#e7eef6",
        secondaryBorderColor: "#334155",
        tertiaryColor: "#0f172a",
        tertiaryTextColor: "#e7eef6",
        tertiaryBorderColor: "#334155",
        lineColor: "#93c5fd",
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
      primaryColor: "#e8eef8",
      primaryTextColor: "#1e293b",
      primaryBorderColor: "#2563eb",
      secondaryColor: "#f8fafc",
      secondaryTextColor: "#1e293b",
      secondaryBorderColor: "#cbd5e1",
      tertiaryColor: "#eff6ff",
      tertiaryTextColor: "#1e293b",
      tertiaryBorderColor: "#93c5fd",
      lineColor: "#2563eb",
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

  function restore(node) {
    var text = node.getAttribute("data-qc-source");
    if (!text) return;
    node.removeAttribute("data-processed");
    node.textContent = text;
  }

  var rendering = false;

  async function render() {
    if (rendering || !window.mermaid) return;
    var nodes = document.querySelectorAll(".mermaid");
    if (!nodes.length) return;
    rendering = true;
    nodes.forEach(function (node) {
      if (!node.getAttribute("data-qc-source")) {
        var raw = (node.textContent || "").trim();
        if (raw && raw.charAt(0) !== "<") node.setAttribute("data-qc-source", raw);
      }
      restore(node);
    });
    mermaid.initialize(config());
    try {
      await mermaid.run({ nodes: nodes, suppressErrors: true });
    } catch (err) {
      /* keep the last successful drawing */
    }
    rendering = false;
  }

  function boot() {
    if (window.document$ && typeof document$.subscribe === "function") {
      document$.subscribe(function () { render(); });
    } else {
      render();
    }
    var last = document.body.getAttribute("data-md-color-scheme");
    new MutationObserver(function () {
      var now = document.body.getAttribute("data-md-color-scheme");
      if (now === last) return;
      last = now;
      render();
    }).observe(document.body, { attributes: true, attributeFilter: ["data-md-color-scheme"] });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
