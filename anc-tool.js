(function () {
  // Must run synchronously at script-eval time: document.currentScript is only valid until the
  // first await/setTimeout. This makes data URLs resolve against THIS script's own host, so the
  // same file works both as a standalone preview and embedded in an EE post on a different domain.
  var scriptBase = (document.currentScript && document.currentScript.src.replace(/[^/]*$/, "")) || "./";

  var CONFIG = {
    ancGeoJSON: scriptBase + "data/anc.geojson",
    smdGeoJSON: scriptBase + "data/smd.geojson",
    roster: scriptBase + "data/roster.csv",
    responses: scriptBase + "data/responses.csv",
    endorsements: scriptBase + "data/endorsements.csv",
    dcBounds: [[38.79, -77.15], [39.00, -76.90]]
  };

  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("Failed to load " + url + " (" + r.status + ")");
      return r.json();
    });
  }

  function fetchCSVRows(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("Failed to load " + url + " (" + r.status + ")");
      return r.text();
    }).then(function (text) {
      return Papa.parse(text.trim(), { skipEmptyLines: true }).data;
    });
  }

  function norm(s) {
    return (s || "").toString().trim();
  }
  function key(smd, name) {
    return norm(smd).toUpperCase() + "||" + norm(name).toLowerCase();
  }
  // Built once the real SMD boundary data loads; do NOT derive ANC from the SMD code by
  // string position, e.g. "3/4G01" (SMDs in ANC 3/4G, which straddles Wards 3 and 4).
  var smdToAnc = {};
  function ancOf(smd) {
    return smdToAnc[norm(smd).toUpperCase()] || norm(smd).slice(0, 2).toUpperCase();
  }

  // --- Parse a raw two-header-row SurveyMonkey export into a structured shape. ---
  // Row 1 = question text (blank means "same question as the column to its left").
  // Row 2 = SurveyMonkey's own sub-label: "Name", "Email", "Response", "Open-Ended Response",
  // or an option label when several columns share one forward-filled question (ranking questions).
  function classifyResponseColumns(row1, row2) {
    var filled = [];
    var last = "";
    for (var i = 0; i < row1.length; i++) {
      var v = norm(row1[i]);
      if (v) last = v;
      filled.push(last);
    }

    var cols = [];
    var i = 0;
    while (i < filled.length) {
      var q = filled[i];
      var sub = norm(row2[i]);

      if (i === 0 && /respondent id/i.test(q)) { cols.push({ role: "skip" }); i++; continue; }
      if (/^name$/i.test(sub)) { cols.push({ role: "name" }); i++; continue; }
      if (/^email$/i.test(sub)) { cols.push({ role: "skip" }); i++; continue; }
      if (/campaign.*social media/i.test(sub) || /fundraising link/i.test(sub)) { cols.push({ role: "skip" }); i++; continue; }
      if (/upload a (photo|headshot|picture|image)/i.test(q)) { cols.push({ role: "skip" }); i++; continue; }
      if (/^select the smd\b/i.test(q)) { cols.push({ role: "smd" }); i++; continue; }
      if (/^select the advisory neighborhood commission/i.test(q) && /^response$/i.test(sub)) { cols.push({ role: "anc" }); i++; continue; }

      // Start (or continue) a question group: gather every contiguous column sharing this question text.
      var j = i;
      var members = [];
      while (j < filled.length && filled[j] === q) {
        members.push({ index: j, sub: norm(row2[j]) });
        j++;
      }
      var isRanking = members.length > 1 && members.every(function (m) { return m.sub && !/^open-ended response$/i.test(m.sub) && !/^response$/i.test(m.sub); });
      var type = isRanking ? "ranking" : (/^open-ended response$/i.test(members[0].sub) ? "openended" : "single");
      for (var m = 0; m < members.length; m++) {
        cols.push({ role: "question", questionKey: q, type: type, option: isRanking ? members[m].sub : null, colIndex: members[m].index });
      }
      i = j;
    }
    return cols;
  }

  function parseResponses(rows) {
    var row1 = rows[0], row2 = rows[1];
    var classified = classifyResponseColumns(row1, row2);
    var questionOrder = [];
    var seen = {};
    classified.forEach(function (c) {
      if (c.role === "question" && !seen[c.questionKey]) { seen[c.questionKey] = true; questionOrder.push({ key: c.questionKey, type: c.type }); }
    });

    var nameIdx = classified.findIndex(function (c) { return c.role === "name"; });
    var smdIdx = classified.findIndex(function (c) { return c.role === "smd"; });

    var byKey = {};
    for (var r = 2; r < rows.length; r++) {
      var row = rows[r];
      if (!row || row.every(function (v) { return !norm(v); })) continue;
      var name = norm(row[nameIdx]);
      var smd = norm(row[smdIdx]);
      if (!name || !smd) continue;
      var answers = {};
      classified.forEach(function (c, idx) {
        if (c.role !== "question") return;
        var val = norm(row[idx]);
        if (!val) return;
        if (c.type === "ranking") {
          answers[c.questionKey] = answers[c.questionKey] || {};
          answers[c.questionKey][c.option] = val;
        } else {
          answers[c.questionKey] = val;
        }
      });
      byKey[key(smd, name)] = { smd: smd, name: name, answers: answers };
    }
    return { byKey: byKey, questions: questionOrder };
  }

  function loadRoster(rows) {
    var header = rows[0].map(function (h) { return norm(h).toLowerCase(); });
    var smdIdx = header.indexOf("smd");
    var nameIdx = header.indexOf("candidate name");
    var list = [];
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !norm(row[nameIdx])) continue;
      list.push({ smd: norm(row[smdIdx]), name: norm(row[nameIdx]) });
    }
    return list;
  }

  function loadEndorsements(rows) {
    var header = rows[0].map(function (h) { return norm(h).toLowerCase(); });
    var smdIdx = header.indexOf("smd");
    var nameIdx = header.indexOf("candidate name");
    var quoteIdx = header.indexOf("pull quote");
    var linkIdx = header.indexOf("writeup link");
    var map = {};
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !norm(row[nameIdx])) continue;
      var smd = norm(row[smdIdx]), name = norm(row[nameIdx]);
      map[key(smd, name)] = { quote: quoteIdx >= 0 ? norm(row[quoteIdx]) : "", link: linkIdx >= 0 ? norm(row[linkIdx]) : "" };
    }
    return map;
  }

  function buildCandidates(rosterList, responseData, endorsementMap) {
    return rosterList.map(function (c) {
      var k = key(c.smd, c.name);
      var resp = responseData.byKey[k];
      var end = endorsementMap[k];
      return {
        smd: c.smd, anc: ancOf(c.smd), name: c.name,
        hasResponse: !!resp, answers: resp ? resp.answers : {},
        endorsed: !!end, quote: end ? end.quote : "", writeupLink: end ? end.link : ""
      };
    });
  }

  // --- Point-in-polygon against the loaded SMD GeoJSON (ray casting), so address search never touches Esri. ---
  function pointInRing(pt, ring) {
    var x = pt[0], y = pt[1], inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      var intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function pointInFeature(lon, lat, feature) {
    var g = feature.geometry;
    var polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    for (var p = 0; p < polys.length; p++) {
      var rings = polys[p];
      if (pointInRing([lon, lat], rings[0])) return true;
    }
    return false;
  }
  function findSMDForPoint(lon, lat, smdGeoJSON) {
    for (var i = 0; i < smdGeoJSON.features.length; i++) {
      if (pointInFeature(lon, lat, smdGeoJSON.features[i])) return smdGeoJSON.features[i];
    }
    return null;
  }

  function escapeHTML(s) {
    return (s || "").toString().replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Edit distance between two strings, used to tolerate minor typos in a candidate-name search.
  function levenshtein(a, b) {
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = [];
    for (var j = 0; j <= n; j++) prev[j] = j;
    for (var i = 1; i <= m; i++) {
      var cur = [i];
      for (var j = 1; j <= n; j++) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    return prev[n];
  }

  // How many typos apart are two words? Scales the tolerance with word length so short words
  // still require a near-exact match while longer names/surnames tolerate a couple of typos.
  function typoThreshold(len) {
    return len <= 3 ? 1 : len <= 6 ? 2 : 3;
  }

  // Score how closely a search query matches a candidate's full name, tolerating minor typos.
  // Every word in the query must approximately match some word in the name (in any order); the
  // score is the total edit distance across those best-matching word pairs, so lower is closer.
  // Returns null if the query doesn't reasonably match at all.
  function fuzzyNameScore(query, name) {
    var qWords = query.toLowerCase().replace(/[.,]/g, "").split(/\s+/).filter(Boolean);
    var nWords = name.toLowerCase().replace(/[.,]/g, "").split(/\s+/).filter(Boolean);
    if (!qWords.length || !nWords.length) return null;
    var total = 0;
    for (var i = 0; i < qWords.length; i++) {
      var qw = qWords[i];
      var best = null;
      for (var j = 0; j < nWords.length; j++) {
        var d = levenshtein(qw, nWords[j]);
        if (d <= typoThreshold(qw.length) && (best === null || d < best)) best = d;
      }
      if (best === null) return null;
      total += best;
    }
    return total;
  }

  function init(rootEl) {
    var statusEl = rootEl.querySelector(".anc-status");
    var selectionEl = rootEl.querySelector(".anc-selection");
    var smdSelect = rootEl.querySelector(".anc-smd-select");
    var searchInput = rootEl.querySelector(".anc-address-input");
    var searchBtn = rootEl.querySelector(".anc-address-btn");

    function setStatus(msg) { statusEl.textContent = msg || ""; }

    var map = L.map(rootEl.querySelector(".anc-map"), { scrollWheelZoom: true }).fitBounds(CONFIG.dcBounds);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 18
    }).addTo(map);

    // Embedded in a CMS post, this script's stylesheet can still be loading (and the container
    // still zero-height) at the instant fitBounds ran above, which throws the initial zoom off.
    // Re-measure once everything has definitely finished loading.
    window.addEventListener("load", function () {
      map.invalidateSize();
      map.fitBounds(CONFIG.dcBounds);
    });

    // The map's CSS height changes at the mobile breakpoint (see anc-tool.css), so a phone
    // rotation or window resize across that width needs Leaflet to re-measure its container —
    // otherwise it keeps rendering at its old pixel size with blank space or clipped tiles.
    // invalidateSize() alone (no fitBounds) preserves whatever the user had panned/zoomed to.
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { map.invalidateSize(); }, 200);
    });

    setStatus("Loading map data…");

    Promise.all([
      fetchJSON(CONFIG.ancGeoJSON),
      fetchJSON(CONFIG.smdGeoJSON),
      fetchCSVRows(CONFIG.roster),
      fetchCSVRows(CONFIG.responses),
      fetchCSVRows(CONFIG.endorsements)
    ]).then(function (results) {
      var ancGeoJSON = results[0], smdGeoJSON = results[1];
      var rosterList = loadRoster(results[2]);
      var responseData = parseResponses(results[3]);
      var endorsementMap = loadEndorsements(results[4]);
      smdGeoJSON.features.forEach(function (f) { smdToAnc[norm(f.properties.SMD_ID).toUpperCase()] = f.properties.ANC_ID; });
      var candidates = buildCandidates(rosterList, responseData, endorsementMap);

      var candidatesBySMD = {};
      candidates.forEach(function (c) {
        (candidatesBySMD[c.smd] = candidatesBySMD[c.smd] || []).push(c);
      });

      L.geoJSON(ancGeoJSON, { style: { color: "#333333", weight: 2, fillOpacity: 0 }, interactive: false }).addTo(map);

      var smdLayer = L.geoJSON(smdGeoJSON, {
        style: { color: "#3d7bb8", weight: 1, fillOpacity: 0.05 },
        onEachFeature: function (feature, layer) {
          layer.on("click", function () { selectSMD(feature.properties.SMD_ID); });
          layer.on("mouseover", function () { layer.setStyle({ fillOpacity: 0.25, fillColor: "#3d7bb8" }); });
          layer.on("mouseout", function () { if (layer !== currentHighlight) layer.setStyle({ fillOpacity: 0.05, fillColor: "#3d7bb8" }); });
          layer.bindTooltip(feature.properties.SMD_ID, {
            permanent: true,
            direction: "center",
            className: "anc-smd-label",
            interactive: false
          });
        }
      }).addTo(map);

      var smdLayers = {};
      smdLayer.eachLayer(function (l) { smdLayers[l.feature.properties.SMD_ID] = l; });
      var currentHighlight = null;

      // Labels for every SMD would be unreadable citywide, so only show them once the map
      // is zoomed in far enough to actually read them (e.g. after an SMD is selected).
      var SMD_LABEL_MIN_ZOOM = 13;
      function updateSMDLabelVisibility() {
        var show = map.getZoom() >= SMD_LABEL_MIN_ZOOM;
        smdLayer.eachLayer(function (l) {
          var tooltip = l.getTooltip();
          var el = tooltip && tooltip.getElement();
          if (el) el.style.display = show ? "" : "none";
        });
      }
      map.on("zoomend", updateSMDLabelVisibility);
      updateSMDLabelVisibility();

      var sortedSMDs = Object.keys(candidatesBySMD).concat(
        smdGeoJSON.features.map(function (f) { return f.properties.SMD_ID; })
          .filter(function (id) { return !candidatesBySMD[id]; })
      ).sort();
      smdSelect.innerHTML = '<option value="">Choose an SMD…</option>' +
        sortedSMDs.map(function (id) { return '<option value="' + id + '">' + id + "</option>"; }).join("");

      var viewMode = "candidate";

      function selectSMD(smdId) {
        if (currentHighlight) currentHighlight.setStyle({ fillOpacity: 0.05, color: "#3d7bb8", fillColor: "#3d7bb8" });
        var layer = smdLayers[smdId];
        if (layer) {
          layer.setStyle({ fillOpacity: 0.35, color: "#1155cc", fillColor: "#1155cc" });
          currentHighlight = layer;
          map.fitBounds(layer.getBounds(), { maxZoom: 15 });
          updateSMDLabelVisibility();
        }
        smdSelect.value = smdId;
        setStatus("");
        viewMode = "candidate";
        renderSelection(smdId);
      }

      function renderSelection(smdId) {
        var list = candidatesBySMD[smdId] || [];
        var html = '<h3 class="anc-selected-heading">SMD ' + smdId + " &mdash; ANC " + ancOf(smdId) + '</h3>';
        if (!list.length) {
          html += '<p class="anc-no-response">No declared candidates on file for this SMD yet.</p>';
        } else {
          var respondentCount = list.filter(function (c) { return c.hasResponse; }).length;
          if (respondentCount >= 2) {
            html += '<div class="anc-view-toggle" role="group" aria-label="Response view">' +
              '<button type="button" class="anc-view-toggle-btn' + (viewMode === "candidate" ? " active" : "") + '" data-mode="candidate">By candidate</button>' +
              '<button type="button" class="anc-view-toggle-btn' + (viewMode === "compare" ? " active" : "") + '" data-mode="compare">Compare by question</button>' +
              "</div>";
          }
          if (viewMode === "compare" && respondentCount >= 2) {
            html += renderCompareView(list);
          } else {
            html += list.map(function (c) { return renderCandidateCard(c, list.length === 1); }).join("");
          }
        }
        selectionEl.innerHTML = html;
        var toggleBtns = selectionEl.querySelectorAll(".anc-view-toggle-btn");
        toggleBtns.forEach(function (btn) {
          btn.addEventListener("click", function () {
            viewMode = btn.getAttribute("data-mode");
            renderSelection(smdId);
          });
        });
      }

      // Group every candidate's answer by question (instead of by candidate) so answers to the
      // same question sit next to each other for direct comparison. Only candidates who actually
      // submitted a response are included as columns; non-respondents have nothing to compare.
      function renderCompareView(list) {
        var respondents = list.filter(function (c) { return c.hasResponse; });
        var nonRespondents = list.filter(function (c) { return !c.hasResponse; });
        var html = "";
        if (nonRespondents.length) {
          html += '<p class="anc-no-response">' + nonRespondents.map(function (c) { return escapeHTML(c.name); }).join(", ") +
            " did not submit a questionnaire response.</p>";
        }
        // Question order comes from respondents' answers (CSV column order already mirrors the
        // original questionnaire's numbered sequence); union across respondents in case any one
        // of them is missing a particular question.
        var questionOrder = [];
        var seen = {};
        respondents.forEach(function (c) {
          Object.keys(c.answers).forEach(function (q) {
            if (!seen[q]) { seen[q] = true; questionOrder.push(q); }
          });
        });
        questionOrder.forEach(function (q) {
          var meta = questionMeta(q);
          html += '<div class="anc-compare-question"><div class="anc-compare-q-text">' + escapeHTML(meta.label) + '</div>';
          html += '<div class="anc-compare-grid">';
          respondents.forEach(function (c) {
            var val = c.answers[q];
            html += '<div class="anc-compare-candidate"><div class="anc-compare-candidate-name">' + escapeHTML(c.name) + "</div>";
            html += val !== undefined ? formatAnswerHTML(meta, val) : '<p class="anc-no-response">Not answered.</p>';
            html += "</div>";
          });
          html += "</div></div>";
        });
        return html;
      }

      // --- Map each (long, verbatim survey) question to its full official wording + topic
      // bucket + (for closed-ended questions) the complete ordered list of answer choices,
      // sourced directly from GGWash's 2026 blank questionnaire template. Showing every choice
      // (not just the one selected) lets readers see what a candidate didn't pick, too.
      // Unmatched questions fall back to their own raw text under "Other" so nothing is silently
      // dropped if the questionnaire changes next cycle.
      var QUESTION_META = [
        { match: new RegExp("not enough homes, enough homes, or too many homes", "i"), topic: "Land Use/Housing", label: "Do you think there are not enough homes, enough homes, or too many homes in your ANC?", options: ["Not enough homes", "Enough homes", "Too many homes"], spotlight: false },
        { match: new RegExp("which of the following statements most aligns with your beliefs", "i"), topic: "Land Use/Housing", label: "Which of the following statements most aligns with your beliefs?", options: ["It's more important to preserve the character of our neighborhoods, and the District’s land-use regulations should reflect that.", "It's more important to enable more homes, and more types of homes, in more of our neighborhoods, even if that results in pushback for “changing a neighborhood’s character.”"], spotlight: false },
        { match: new RegExp("i consider affordable housing to be", "i"), topic: "Land Use/Housing", label: "I consider affordable housing to be (check all that, in your opinion, apply):", options: ["Means-tested or income-restricted", "Built by the government", "Cheap", "Subsidized", "Rent-controlled", "Costing no more than 30 percent of one’s household income"], spotlight: false },
        { match: new RegExp("i consider market-rate housing to be", "i"), topic: "Land Use/Housing", label: "I consider market-rate housing to be (check all that, in your opinion, apply):", options: ["Not means-tested or income-restricted", "Built by private developers", "Expensive", "Unsubsidized", "Not rent-controlled", "Costing more than 30 percent of one’s household income"], spotlight: false },
        { match: new RegExp("distinction between affordable hou", "i"), topic: "Land Use/Housing", label: "If you’d like, elaborate on what you believe to be the distinction between affordable housing and market-rate housing. (Max. 1,500 characters.)", options: null, spotlight: false },
        { match: new RegExp("check any of the below combinations", "i"), topic: "Land Use/Housing", label: "Check any of the below combinations of features that you would consider social housing.", options: ["District-owned housing on District-owned land, built by a District agency and managed by a District agency", "District-owned housing on District-owned land, built by a District agency and managed by a private property-management company", "District-owned housing on District-owned land, built by a private construction company and managed by a District agency", "District-owned housing on District-owned land, built by a private construction company and managed by a private property-management company"], spotlight: false },
        { match: new RegExp("family-sized housing mean", "i"), topic: "Land Use/Housing", label: "What does family-sized housing mean to you? (Max. 1,500 characters.)", options: null, spotlight: false },
        { match: new RegExp("historic districts, enough historic districts", "i"), topic: "Land Use/Housing", label: "Are there not enough historic districts, enough historic districts, or too many historic districts in your ANC?", options: ["Not enough historic districts", "Enough historic districts", "Too many historic districts"], spotlight: false },
        { match: new RegExp("inducing residents and visitors to drive less", "i"), topic: "Transportation", label: "Do you think inducing residents and visitors to drive less should be an explicit policy goal of the District?", options: ["Yes, inducing residents and visitors to drive less should be an explicit policy goal of the District.", "No, inducing residents and visitors to drive less should not be an explicit policy goal of the District."], spotlight: false },
        { match: new RegExp("not enough cars, enough cars, or too many cars", "i"), topic: "Transportation", label: "Do you think there are not enough cars, enough cars, or too many cars in the District?", options: ["Not enough cars", "Enough cars", "Too many cars"], spotlight: false },
        { match: new RegExp("how many vehicles.*family of four", "i"), topic: "Transportation", label: "How many vehicles do you think a family of four needs to get by in the District?", options: ["Zero", "One", "Two", "Three or more"], spotlight: false },
        { match: new RegExp("not enough parking, enough parking, or too much parking", "i"), topic: "Transportation", label: "Do you think there is not enough parking, enough parking, or too much parking in your ANC?", options: ["Not enough parking", "Enough parking", "Too much parking"], spotlight: false },
        { match: new RegExp("too few bars and restaurants", "i"), topic: "Land Use/Housing", label: "Do you think there are too few bars and restaurants, enough bars and restaurants, or too many bars and restaurants in your ANC?", options: ["Too few bars and restaurants", "Enough bars and restaurants", "Too many bars and restaurants"], spotlight: false },
        { match: new RegExp("^which statement do you agree with most", "i"), topic: "Land Use/Housing", label: "Which statement do you agree with most?", options: ["Little or no new housing should be built anywhere in the District.", "New housing should be built almost exclusively near transit or on major corridors. Adding new housing is important, but so is protecting neighborhoods from change. Limiting denser development to land near transit or on major corridors is a reasonable compromise.", "New housing of all types should be built throughout all neighborhoods. Building more densely near transit is important, but people also deserve the option to live in rowhomes and small apartment buildings, even if those homes are not within a set proximity to a bus stop or train station."], spotlight: false },
        { match: new RegExp("should apartments.{0,20}sixplexes.{0,20}be legal", "i"), topic: "Land Use/Housing", label: "Should apartments—for example, sixplexes—be legal in all parts of all the District's neighborhoods?", options: ["Yes, apartments should be legal in all parts of all the District's neighborhoods.", "Yes, apartments should be legal in all parts of all the District’s neighborhoods, and I would introduce a resolution supporting the legalization of sixplexes in the Comprehensive Plan rewrite.", "No, apartments should not be legal in all parts of all the District's neighborhoods.", "No, apartments should not be legal in all parts of all the District’s neighborhoods, and I would oppose a resolution in support of such a policy."], spotlight: false },
        { match: new RegExp("selected,? ?\"no,?\" explain why.*apartments", "i"), topic: "Land Use/Housing", label: "If you selected, \"No,\" explain why you think apartments shouldn't be legal in all parts of all the District’s neighborhoods. Otherwise, write N/A. (Max. 3,000 characters.)", options: null, spotlight: false },
        { match: new RegExp("historic preservation laws be amended", "i"), topic: "Land Use/Housing", label: "Should the District’s historic preservation laws be amended to remove height and mass from the purview of the Historic Preservation Review Board?", options: ["Yes, height and mass should be removed from the purview of the Historic Preservation Review Board.", "Yes, height and mass should be removed from the purview of the Historic Preservation Review Board, and I would introduce a resolution supporting such a policy.", "No, height and mass should not be removed from the purview of the Historic Preservation Review Board.", "No, height and mass should not be removed from the purview of the Historic Preservation Review Board, and I would oppose a resolution in support of such a policy."], spotlight: false },
        { match: new RegExp("bowser failed to meet her 2019 target", "i"), topic: "Land Use/Housing", label: "Mayor Muriel Bowser failed to meet her 2019 target of achieving “an equitable distribution of no less than 15 percent affordable housing in each planning area by 2050.\" Do you agree that 15 percent of all homes in a planning area should be affordable?", options: ["I agree that 15 percent of all homes in a planning area should be affordable.", "I agree that 15 percent of all homes in a planning area should be affordable, and would introduce a resolution in support of such a policy.", "I do not agree that 15 percent of all homes in a planning area should be affordable.", "I do not agree that 15 percent of all homes in a planning area should be affordable, and would introduce a resolution in opposition to such a policy."], spotlight: false },
        { match: new RegExp("janeese lewis george", "i"), topic: "Land Use/Housing", label: "Janeese Lewis George, the Democratic nominee for mayor of Washington, D.C., committed to a goal of building 72,000 new homes in five years. That’s equal to about 210 units per single-member district, or 1,565 units per ANC. Hypothetically, where do you think 210 new homes should be built in your SMD or ANC? If you do not think new housing should be built in your SMD or ANC, please write, \"I do not think new housing should be built in my SMD or ANC.” (Max. 3,000 characters.)", options: null, spotlight: false },
        { match: new RegExp("planned unit developments .allow developers", "i"), topic: "Land Use/Housing", label: "In the District, planned unit developments “allow developers flexibility to meet objectives such as use, density, site planning, and design” by incorporating “public benefits that exceed those that could have been achieved under the general provisions of the Zoning Regulations.” Not all commissioners will work on a PUD but, if one is proposed, ANCs may be able to negotiate which benefits developers might provide in exchange for greater height and density. Developers rarely propose PUDs because of the time and complexity that the Zoning Commission has added to approvals. Which of the following statements most aligns with your preferences?", options: ["I would prefer to negotiate a PUD. The delay in the production of new housing is worth the potential for—if not the guarantee of—benefits such as improvements to streets and sidewalks or more income-restricted, subsidized units than are required by District law.", "I would prefer that development in my ANC be by-right. Knowing that what is zoned is all that is possible to build creates predictability for residents and housing providers, which is worth forgoing a negotiation for possible benefits."], spotlight: false },
        { match: new RegExp("zoning commission a proposal", "i"), topic: "Land Use/Housing", label: "Greater Greater Washington is considering submitting to the Zoning Commission a proposal to enable a variety of smaller-scale housing types where they are not currently possible to build. Our proposal would allow one additional home per lot in R and RF zones. It would also decrease minimum lot area and width, and increase minimum lot capacity. You can see what parts of the District those zones cover on our indicator map. Would you support a proposal that enabled the following?\n\nIncreasing the homes allowed in R-1A zones from one to two per lot\nIncreasing the homes allowed in R-1B, R-2, and R-3 zones from one to three per lot\nIncreasing the homes allowed in RF-1 zones from two to three per lot\nIncreasing the homes allowed in RF-4 zones from three to four per lot\nIncreasing the homes allowed in RF-5 zones from four to five per lot", options: ["I would support a zoning text amendment enabling an additional home per lot in R and RF zones.", "I would support enabling an additional home per lot in R and RF zones, and would introduce a resolution in support of such a zoning text amendment.", "I would not support enabling an additional home per lot in R and RF zones.", "I would not support enabling an additional home per lot in R and RF zones, and would introduce a resolution in opposition to such a zoning text amendment."], spotlight: false },
        { match: new RegExp("no longer consider someone.s home .near transit", "i"), topic: "Transportation", label: "At what point do you no longer consider someone’s home “near transit”?", options: ["If their home is further than a five-minute walk to a bus stop or train station.", "If their home is further than a 10-minute walk to a bus stop or train station.", "If their home is further than a 15-minute walk to a bus stop or train station.", "If their home is further than a 20-minute walk to a bus stop or train station.", "If their home is further than a 30-minute walk or longer to a bus stop or train station."], spotlight: false },
        { match: new RegExp("dedicated bus lanes", "i"), topic: "Transportation", label: "Do you support removing parking and travel lanes to build dedicated bus lanes? See how many people in your ANC and SMD live near frequent transit on our indicator map.", options: ["Yes, I support removing parking and travel lanes to build dedicated bus lanes.", "Yes, I support removing parking and travel lanes to build dedicated bus lanes, and would introduce a resolution in support of doing so in my ANC.", "No, I do not support removing parking and travel lanes to build dedicated bus lanes.", "No, I do not support removing parking and travel lanes to build dedicated bus lanes, and would introduce a resolution in opposition to doing so in my ANC."], spotlight: false },
        { match: new RegExp("protected bike lanes", "i"), topic: "Transportation", label: "Do you support removing parking and travel lanes to build protected bike lanes? See how many people in your ANC and SMD live near protected bike lanes on our indicator map.", options: ["Yes, I support removing parking and travel lanes to build protected bike lanes.", "Yes, I support removing parking and travel lanes to build protected bike lanes, and would introduce a resolution in support of doing so in my ANC.", "No, I do not support removing parking and travel lanes to build protected bike lanes.", "No, I do not support removing parking and travel lanes to build protected bike lanes, and would introduce a resolution in opposition to doing so in my ANC."], spotlight: false },
        { match: new RegExp("road pricing", "i"), topic: "Transportation", label: "Do you support the implementation of road pricing (also referred to as congestion pricing) in downtown Washington, D.C.? The “small study area” in the map below shows approximately where a road-pricing charge could apply.Since a $9 congestion toll was introduced in Manhattan in January 2025, it has generated $700 million in revenue for New York City. Broadway had its highest-grossing year on record, and air quality improved across all five boroughs. Traffic injuries dropped in the congestion relief zone. In 2024, there were 6,455 reported crashes and 3,117 injuries. By 2025, reported crashes had dropped 5 percent, to 6,137, and injuries dropped 3.6 percent, to 3,003. https://surveymonkey-assets.s3.amazonaws.com/survey/528100308/rte/0fbead89-6503-41b9-b75a-3df3cc86dddc.png", options: ["Yes, I support the implementation of road pricing.", "Yes, I support the implementation of road pricing, and would introduce a resolution in support of the District doing so.", "No, I do not support the implementation of road pricing.", "No, I do not support the implementation of road pricing, and would introduce a resolution in opposition to the District doing so."], spotlight: false },
        { match: new RegExp("national week without driving", "i"), topic: "Transportation", label: "Will you participate in the yearly National Week Without Driving?", options: ["Yes, I will participate in the National Week Without Driving every fall.", "No, I will not participate in the National Week Without Driving every fall."], spotlight: false },
        { match: new RegExp("carbon-free by 2045", "i"), topic: "Transportation", label: "The District's plan to be carbon-free by 2045 requires residents to reduce the trips they take by car. Please describe at least one trip you currently take by car (even if you, yourself, are not driving) that you can commit to taking on foot, by bus, by train, via a mobility device, or by bike instead. (Max. 1,500 characters.)", options: null, spotlight: false },
        { match: new RegExp("biggest issue", "i"), topic: null, label: "What do you feel is the biggest issue in your neighborhood, and what is your position on it? Given the limited scope of commissioners’ authority, what would you most realistically do about that issue if elected? (Max. 1,500 characters each.)", options: null, spotlight: true },
        { match: new RegExp("anc commissioners represent about 2,000", "i"), topic: "Other", label: "ANC commissioners represent about 2,000 constituents, on average. With the understanding that you are not going to hear from every single one of them during your term, and that those you do hear from may not represent a majority view of the 2,000 people you represent, describe how you plan to make decisions as an elected representative. (Max. 3,000 characters.)", options: null, spotlight: false },
        { match: new RegExp("why do you think you are the right person", "i"), topic: "Other", label: "Why do you think you are the right person to serve as an ANC commissioner for your SMD? (Max. 1,500 characters.)", options: null, spotlight: false },
        { match: new RegExp("anything else you.d like ggwash to take into consideration", "i"), topic: "Other", label: "Is there anything else you'd like GGWash to take into consideration about your positions on housing, affordable housing, transportation, and land use? (Max. 3,000 characters.)", options: null, spotlight: false }
      ];
      function questionMeta(q) {
        for (var i = 0; i < QUESTION_META.length; i++) {
          if (QUESTION_META[i].match.test(q)) return QUESTION_META[i];
        }
        return { topic: "Other", label: q, options: null, spotlight: false };
      }

      // Render every possible answer choice for a closed-ended question, marking which one(s)
      // the candidate actually chose so readers can see the options they passed over too.
      function renderOptionsHTML(options, rawVal) {
        var chosen = String(rawVal).split(";").map(function (s) { return s.trim(); }).filter(Boolean);
        var chosenNorm = chosen.map(function (s) { return s.toLowerCase(); });
        return '<ul class="anc-option-list">' + options.map(function (opt) {
          var isChosen = chosenNorm.indexOf(opt.toLowerCase()) !== -1;
          return '<li class="anc-option' + (isChosen ? ' anc-option-chosen' : ' anc-option-unchosen') + '">' +
            '<span class="anc-option-marker" aria-hidden="true">' + (isChosen ? "\u25CF" : "\u25CB") + '</span>' +
            '<span class="anc-option-text">' + escapeHTML(opt) + "</span></li>";
        }).join("") + "</ul>";
      }

      function formatAnswerHTML(meta, val) {
        if (val && typeof val === "object") {
          var items = Object.keys(val).sort(function (a, b) { return val[a] - val[b]; });
          return '<ol class="anc-rank-list">' + items.map(function (o) { return "<li>" + escapeHTML(o) + "</li>"; }).join("") + "</ol>";
        }
        if (meta.options) return renderOptionsHTML(meta.options, val);
        var str = String(val);
        if (/check (all|any)/i.test(meta.label) && str.indexOf(";") !== -1) {
          var tags = str.split(";").map(function (s) { return s.trim(); }).filter(Boolean);
          return '<div class="anc-tag-list">' + tags.map(function (t) { return '<span class="anc-tag">' + escapeHTML(t) + "</span>"; }).join("") + "</div>";
        }
        if (str.length > 120) return '<p class="anc-answer-long">' + escapeHTML(str) + "</p>";
        return escapeHTML(str);
      }

      function initials(name) {
        var words = norm(name).split(/\s+/).filter(Boolean);
        if (!words.length) return "?";
        var first = words[0].charAt(0);
        var last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
        return (first + last).toUpperCase();
      }

      function renderCandidateCard(c, openByDefault) {
        var card = '<div class="anc-candidate-card' + (c.endorsed ? " endorsed" : "") + '">';
        card += '<div class="anc-candidate-header">';
        card += '<div class="anc-avatar" aria-hidden="true">' + escapeHTML(initials(c.name)) + "</div>";
        card += '<div class="anc-candidate-headtext">';
        card += '<p class="anc-candidate-name">' + escapeHTML(c.name) + "</p>";
        card += "</div>"; // .anc-candidate-headtext
        card += "</div>"; // .anc-candidate-header
        if (c.endorsed) {
          card += '<div class="anc-endorsed-ribbon">GGWash endorsed</div>';
          if (c.quote) card += '<p class="anc-pull-quote">“' + escapeHTML(c.quote) + '”</p>';
          if (c.writeupLink) card += '<p class="anc-writeup-link"><a href="' + escapeHTML(c.writeupLink) + '" target="_blank" rel="noopener">Read the endorsement writeup</a></p>';
        }
        if (!c.hasResponse) {
          card += '<p class="anc-no-response">' + escapeHTML(c.name) + " did not submit a questionnaire response.</p>";
        } else {
          card += '<details class="anc-responses"' + (openByDefault ? " open" : "") + '><summary>View questionnaire responses</summary>';
          // Render every answer in the same sequence as the original questionnaire (the CSV's
          // column order already mirrors the numbered question order), rather than grouping by
          // topic or pulling any one question out to the top.
          Object.keys(c.answers).forEach(function (q) {
            var val = c.answers[q];
            var meta = questionMeta(q);
            card += '<div class="anc-answer-row"><div class="anc-answer-q">' + escapeHTML(meta.label) + '</div><div class="anc-answer-a">' + formatAnswerHTML(meta, val) + "</div></div>";
          });
          card += "</details>";
        }
        card += "</div>";
        return card;
      }

      smdSelect.addEventListener("change", function () { if (smdSelect.value) selectSMD(smdSelect.value); });

      searchBtn.addEventListener("click", function () {
        var q = searchInput.value.trim();
        if (!q) return;
        var looksLikeAddress = /\d/.test(q); // addresses have a house number; candidate names never do

        if (!looksLikeAddress) {
          var qn = q.toLowerCase();
          var nameMatches = candidates.filter(function (c) { return c.name.toLowerCase().indexOf(qn) !== -1; });
          var isFuzzy = false;

          if (!nameMatches.length) {
            // No exact/substring hit — tolerate a minor typo instead of giving up.
            var scored = candidates.map(function (c) { return { c: c, score: fuzzyNameScore(q, c.name) }; })
              .filter(function (s) { return s.score !== null; })
              .sort(function (a, b) { return a.score - b.score; });
            if (scored.length) {
              var bestScore = scored[0].score;
              nameMatches = scored.filter(function (s) { return s.score <= bestScore; }).map(function (s) { return s.c; });
              isFuzzy = true;
            }
          }

          if (nameMatches.length === 1) {
            setStatus(isFuzzy ? "Showing closest match: " + nameMatches[0].name : "");
            selectSMD(nameMatches[0].smd);
            return;
          }
          if (nameMatches.length > 1) {
            statusEl.innerHTML = (isFuzzy ? "Did you mean one of these? " : "Multiple candidates matched — choose one: ") + nameMatches.map(function (c) {
              return '<button type="button" class="anc-search-suggestion" data-smd="' + escapeHTML(c.smd) + '">' +
                escapeHTML(c.name) + " (SMD " + escapeHTML(c.smd) + ")</button>";
            }).join(" ");
            statusEl.querySelectorAll(".anc-search-suggestion").forEach(function (btn) {
              btn.addEventListener("click", function () { setStatus(""); selectSMD(btn.getAttribute("data-smd")); });
            });
            return;
          }
        }

        // No candidate name matched — treat the query as an address instead.
        setStatus("Searching…");
        var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&viewbox=-77.15,39.00,-76.90,38.79&bounded=1&q=" + encodeURIComponent(q + ", Washington, DC");
        fetch(url).then(function (r) { return r.json(); }).then(function (results) {
          if (!results.length) { setStatus("Couldn't find that address or candidate — check the spelling, or include the street type (Ave, St, etc.) for an address."); return; }
          var lat = parseFloat(results[0].lat), lon = parseFloat(results[0].lon);
          var feature = findSMDForPoint(lon, lat, smdGeoJSON);
          if (!feature) { setStatus("That address doesn't fall inside a known SMD."); return; }
          selectSMD(feature.properties.SMD_ID);
        }).catch(function () { setStatus("Search failed — try the dropdown instead."); });
      });

      setStatus("");
    }).catch(function (err) {
      setStatus("Couldn't load the tool's data: " + err.message);
    });
  }

  document.querySelectorAll(".anc-tool").forEach(init);
})();
