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
    var siteIdx = header.indexOf("website");
    var list = [];
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !norm(row[nameIdx])) continue;
      list.push({ smd: norm(row[smdIdx]), name: norm(row[nameIdx]), website: siteIdx >= 0 ? norm(row[siteIdx]) : "" });
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
        smd: c.smd, anc: ancOf(c.smd), name: c.name, website: c.website,
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

  function init(rootEl) {
    var statusEl = rootEl.querySelector(".anc-status");
    var selectionEl = rootEl.querySelector(".anc-selection");
    var chartsEl = rootEl.querySelector(".anc-charts");
    var smdSelect = rootEl.querySelector(".anc-smd-select");
    var searchInput = rootEl.querySelector(".anc-address-input");
    var searchBtn = rootEl.querySelector(".anc-address-btn");

    function setStatus(msg) { statusEl.textContent = msg || ""; }

    var map = L.map(rootEl.querySelector(".anc-map"), { scrollWheelZoom: false }).fitBounds(CONFIG.dcBounds);
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
        style: { color: "#5b9bd5", weight: 1, fillOpacity: 0.05 },
        onEachFeature: function (feature, layer) {
          layer.on("click", function () { selectSMD(feature.properties.SMD_ID); });
          layer.on("mouseover", function () { layer.setStyle({ fillOpacity: 0.25, fillColor: "#5b9bd5" }); });
          layer.on("mouseout", function () { if (layer !== currentHighlight) layer.setStyle({ fillOpacity: 0.05, fillColor: "#5b9bd5" }); });
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
        sortedSMDs.map(function (id) { return '<option value="' + id + '">' + id + " (ANC " + ancOf(id) + ")</option>"; }).join("");

      function selectSMD(smdId) {
        if (currentHighlight) currentHighlight.setStyle({ fillOpacity: 0.05, color: "#5b9bd5", fillColor: "#5b9bd5" });
        var layer = smdLayers[smdId];
        if (layer) {
          layer.setStyle({ fillOpacity: 0.35, color: "#1155cc", fillColor: "#1155cc" });
          currentHighlight = layer;
          map.fitBounds(layer.getBounds(), { maxZoom: 15 });
          updateSMDLabelVisibility();
        }
        smdSelect.value = smdId;
        setStatus("");
        renderSelection(smdId);
      }

      function renderSelection(smdId) {
        var list = candidatesBySMD[smdId] || [];
        var html = '<h3 class="anc-selected-heading">SMD ' + smdId + " &mdash; ANC " + ancOf(smdId) + '</h3>';
        if (!list.length) {
          html += '<p class="anc-no-response">No declared candidates on file for this SMD yet.</p>';
        } else {
          html += list.map(renderCandidateCard).join("");
        }
        selectionEl.innerHTML = html;
      }

      // --- Map each (long, verbatim survey) question to a short display label + topic bucket. ---
      // Hand-curated against this specific 2024 questionnaire's real question text; unmatched
      // questions fall back to a truncated version of their own text under "Other" so nothing
      // is silently dropped if the questionnaire changes next cycle.
      var QUESTION_META = [
        { match: /biggest issue/i, topic: "spotlight", label: "Biggest issue in the neighborhood" },
        { match: /where in your advisory neighborhood commission.*density/i, topic: "Housing & Development", label: "Where density should increase" },
        { match: /i consider affordable housing/i, topic: "Housing & Development", label: "What counts as \u201caffordable housing\u201d" },
        { match: /i consider market-rate housing/i, topic: "Housing & Development", label: "What counts as \u201cmarket-rate housing\u201d" },
        { match: /inclusionary zoning law/i, topic: "Housing & Development", label: "Response to pushback on an IZ project" },
        { match: /planned unit developments/i, topic: "Housing & Development", label: "PUD community-benefit priorities (ranked)" },
        { match: /check any of the below combinations.*social housing/i, topic: "Housing & Development", label: "What counts as \u201csocial housing\u201d" },
        { match: /should apartments be legal/i, topic: "Housing & Development", label: "Apartments legal District-wide?" },
        { match: /which statement do you agree with most/i, topic: "Housing & Development", label: "Where new housing should go" },
        { match: /historic districts/i, topic: "Housing & Development", label: "Views on historic districts" },
        { match: /rewrite of its comprehensive plan/i, topic: "Housing & Development", label: "Comp Plan rewrite top priority" },
        { match: /my anc, not just my smd, has/i, topic: "Housing & Development", label: "Bars & restaurants in the ANC" },
        { match: /not enough cars, enough cars, or too many cars/i, topic: "Transportation & Streets", label: "Enough cars in DC?" },
        { match: /sustainable d\.c\. 2\.0/i, topic: "Transportation & Streets", label: "Reduce car trips as a policy goal?" },
        { match: /incentives for people to drive less/i, topic: "Transportation & Streets", label: "Traffic-safety policy priorities (ranked)" },
        { match: /the above question asks about systemic policies/i, topic: "Transportation & Streets", label: "Local street-safety initiatives (ranked)" },
        { match: /on-street parking occurs in public space/i, topic: "Transportation & Streets", label: "Reasonable street-parking availability" },
        { match: /carbon-free by 2050/i, topic: "Transportation & Streets", label: "A car trip they'd switch" },
        { match: /anc commissioners represent about 2,000/i, topic: "Governance & Representation", label: "How they'd represent all constituents" },
        { match: /why do you think you are the right person/i, topic: "Governance & Representation", label: "Why they're the right person" }
      ];
      var TOPIC_ORDER = ["Housing & Development", "Transportation & Streets", "Governance & Representation"];
      function questionMeta(q) {
        for (var i = 0; i < QUESTION_META.length; i++) {
          if (QUESTION_META[i].match.test(q)) return QUESTION_META[i];
        }
        return { topic: "Other", label: q.length > 90 ? q.slice(0, 87) + "\u2026" : q };
      }

      function formatAnswerHTML(questionKey, val) {
        if (val && typeof val === "object") {
          var items = Object.keys(val).sort(function (a, b) { return val[a] - val[b]; });
          return '<ol class="anc-rank-list">' + items.map(function (o) { return "<li>" + escapeHTML(o) + "</li>"; }).join("") + "</ol>";
        }
        var str = String(val);
        if (/check (all|any)/i.test(questionKey)) {
          var tags = str.split(";").map(function (s) { return s.trim(); }).filter(Boolean);
          return '<div class="anc-tag-list">' + tags.map(function (t) { return '<span class="anc-tag">' + escapeHTML(t) + "</span>"; }).join("") + "</div>";
        }
        if (str.length > 120) return '<p class="anc-answer-long">' + escapeHTML(str) + "</p>";
        return escapeHTML(str);
      }

      function renderCandidateCard(c) {
        var nameHTML = c.website ? '<a href="' + escapeHTML(c.website) + '" target="_blank" rel="noopener">' + escapeHTML(c.name) + "</a>" : escapeHTML(c.name);
        var card = '<div class="anc-candidate-card' + (c.endorsed ? " endorsed" : "") + '">';
        card += '<p class="anc-candidate-name">' + nameHTML + "</p>";
        if (c.endorsed) {
          card += '<div class="anc-endorsed-ribbon">GGWash endorsed</div>';
          if (c.quote) card += '<p class="anc-pull-quote">“' + escapeHTML(c.quote) + '”</p>';
          if (c.writeupLink) card += '<p class="anc-writeup-link"><a href="' + escapeHTML(c.writeupLink) + '" target="_blank" rel="noopener">Read the endorsement writeup</a></p>';
        }
        if (!c.hasResponse) {
          card += '<p class="anc-no-response">No questionnaire response on file.</p>';
        } else {
          var topics = {};
          var spotlight = null;
          Object.keys(c.answers).forEach(function (q) {
            var val = c.answers[q];
            var meta = questionMeta(q);
            if (meta.topic === "spotlight") { spotlight = { label: meta.label, val: val }; return; }
            (topics[meta.topic] = topics[meta.topic] || []).push({ label: meta.label, q: q, val: val });
          });
          if (spotlight) {
            card += '<div class="anc-spotlight"><div class="anc-spotlight-label">' + escapeHTML(spotlight.label) + '</div>' +
              '<p class="anc-answer-long">' + escapeHTML(spotlight.val) + "</p></div>";
          }
          var topicNames = TOPIC_ORDER.concat(Object.keys(topics).filter(function (t) { return TOPIC_ORDER.indexOf(t) === -1; }));
          topicNames.forEach(function (topicName) {
            var items = topics[topicName];
            if (!items || !items.length) return;
            card += '<details class="anc-topic"><summary>' + escapeHTML(topicName) + ' <span class="anc-topic-count">(' + items.length + ")</span></summary>";
            items.forEach(function (item) {
              card += '<div class="anc-answer-row"><div class="anc-answer-q">' + escapeHTML(item.label) + '</div><div class="anc-answer-a">' + formatAnswerHTML(item.q, item.val) + "</div></div>";
            });
            card += "</details>";
          });
        }
        card += "</div>";
        return card;
      }

      // --- Turn a batch of free-text answers into a frequency-sized word cloud. ---
      // Deliberately simple word-frequency counting (no external NLP library): as more real
      // responses come in, recurring themes (e.g. "speeding", "traffic") naturally surface as
      // the largest words without needing a hand-maintained theme taxonomy.
      var WORDCLOUD_STOPWORDS = {
        "the": 1, "a": 1, "an": 1, "and": 1, "or": 1, "of": 1, "in": 1, "on": 1, "at": 1, "to": 1,
        "is": 1, "are": 1, "was": 1, "were": 1, "be": 1, "being": 1, "been": 1, "for": 1, "with": 1,
        "without": 1, "that": 1, "this": 1, "these": 1, "those": 1, "it": 1, "its": 1, "our": 1,
        "we": 1, "i": 1, "my": 1, "me": 1, "you": 1, "your": 1, "they": 1, "them": 1, "their": 1,
        "there": 1, "here": 1, "more": 1, "most": 1, "some": 1, "any": 1, "all": 1, "not": 1, "no": 1,
        "so": 1, "as": 1, "if": 1, "than": 1, "then": 1, "also": 1, "just": 1, "really": 1, "very": 1,
        "have": 1, "has": 1, "had": 1, "will": 1, "would": 1, "should": 1, "could": 1, "can": 1,
        "do": 1, "does": 1, "did": 1, "feel": 1, "think": 1, "biggest": 1, "issue": 1, "issues": 1,
        "neighborhood": 1, "neighborhoods": 1, "about": 1, "into": 1, "from": 1, "by": 1, "up": 1,
        "out": 1, "get": 1, "getting": 1, "much": 1, "many": 1, "lot": 1, "lack": 1
      };
      function stem(word) {
        if (word.length > 5 && word.slice(-3) === "ing") return word.slice(0, -3);
        if (word.length > 5 && word.slice(-3) === "ies") return word.slice(0, -3) + "y";
        if (word.length > 5 && word.slice(-2) === "ed" && word.slice(-3) !== "eed") return word.slice(0, -2);
        if (word.length > 4 && word.slice(-1) === "s" && word.slice(-2) !== "ss") return word.slice(0, -1);
        return word;
      }
      function buildWordCloud(texts) {
        var counts = {};
        var displayForm = {};
        texts.forEach(function (text) {
          norm(text).toLowerCase().split(/[^a-z']+/).forEach(function (raw) {
            if (!raw || raw.length < 3 || WORDCLOUD_STOPWORDS[raw]) return;
            var stemmed = stem(raw);
            if (WORDCLOUD_STOPWORDS[stemmed]) return;
            counts[stemmed] = (counts[stemmed] || 0) + 1;
            displayForm[stemmed] = displayForm[stemmed] || raw;
          });
        });
        var entries = Object.keys(counts).map(function (k) { return { word: displayForm[k], count: counts[k] }; });
        entries.sort(function (a, b) { return b.count - a.count; });
        return entries.slice(0, 40);
      }
      function renderWordCloudHTML(entries) {
        if (!entries.length) return '<p class="anc-no-response">No responses yet for this question.</p>';
        var counts = entries.map(function (e) { return e.count; });
        var minCount = Math.min.apply(null, counts), maxCount = Math.max.apply(null, counts);
        var minFont = 14, maxFont = 42;
        var palette = ["#0f9535", "#0b7229", "#333333", "#9db2a3"];
        // Shuffle for an organic cloud layout, independent of frequency order.
        var shuffled = entries.slice();
        for (var i = shuffled.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
        }
        var html = '<div class="anc-wordcloud">';
        shuffled.forEach(function (e, idx) {
          var size = maxCount === minCount ? (minFont + maxFont) / 2 :
            minFont + (e.count - minCount) / (maxCount - minCount) * (maxFont - minFont);
          var color = palette[idx % palette.length];
          html += '<span class="anc-wordcloud-word" style="font-size:' + size.toFixed(0) + 'px;color:' + color +
            '" title="' + e.count + (e.count === 1 ? " mention" : " mentions") + '">' + escapeHTML(e.word) + "</span>";
        });
        html += "</div>";
        return html;
      }

      function renderCitywideCharts() {
        var responded = candidates.filter(function (c) { return c.hasResponse; });
        var html = '<h3 class="anc-charts-heading">How all candidates responded</h3>' +
          '<p class="anc-charts-sub">Aggregated across all ' + responded.length + " candidates who submitted a questionnaire response, citywide.</p>";
        responseData.questions.forEach(function (q) {
          var shortLabel = questionMeta(q.key).label;
          if (q.type === "openended") {
            var quotes = responded.map(function (c) { return c.answers[q.key]; }).filter(Boolean);
            if (!quotes.length) return;
            if (/biggest issue/i.test(q.key)) {
              html += '<div class="anc-chart-block"><div class="anc-chart-question">' + escapeHTML(shortLabel) + "</div>" +
                renderWordCloudHTML(buildWordCloud(quotes)) + "</div>";
              return;
            }
            html += '<div class="anc-chart-block"><div class="anc-chart-question">' + escapeHTML(shortLabel) + '</div><ul class="anc-quotes-list">' +
              quotes.slice(0, 8).map(function (qt) { return "<li>“" + escapeHTML(qt) + "”</li>"; }).join("") + "</ul></div>";
            return;
          }
          var counts = {};
          var isRanking = q.type === "ranking";
          responded.forEach(function (c) {
            var val = c.answers[q.key];
            if (!val) return;
            if (isRanking) {
              Object.keys(val).forEach(function (opt) {
                counts[opt] = counts[opt] || { sum: 0, n: 0 };
                counts[opt].sum += Number(val[opt]) || 0;
                counts[opt].n++;
              });
            } else {
              counts[val] = (counts[val] || 0) + 1;
            }
          });
          var entries;
          var maxVal;
          if (isRanking) {
            entries = Object.keys(counts).map(function (opt) { return { label: opt, value: counts[opt].sum / counts[opt].n }; });
            entries.sort(function (a, b) { return a.value - b.value; });
            maxVal = Math.max.apply(null, entries.map(function (e) { return e.value; })) || 1;
          } else {
            entries = Object.keys(counts).map(function (opt) { return { label: opt, value: counts[opt] }; });
            entries.sort(function (a, b) { return b.value - a.value; });
            maxVal = Math.max.apply(null, entries.map(function (e) { return e.value; })) || 1;
          }
          if (!entries.length) return;
          html += '<div class="anc-chart-block"><div class="anc-chart-question">' + escapeHTML(shortLabel) + (isRanking ? " (average rank, lower = higher priority)" : "") + "</div>";
          entries.forEach(function (e) {
            var pct = isRanking ? Math.max(6, 100 - (e.value / maxVal) * 100) : Math.max(6, (e.value / maxVal) * 100);
            html += '<div class="anc-bar-row"><div class="anc-bar-label">' + escapeHTML(e.label) + '</div><div class="anc-bar-track"><div class="anc-bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div><div class="anc-bar-count">' + (isRanking ? e.value.toFixed(1) : e.value) + "</div></div>";
          });
          html += "</div>";
        });
        chartsEl.innerHTML = html;
      }

      renderCitywideCharts();

      smdSelect.addEventListener("change", function () { if (smdSelect.value) selectSMD(smdSelect.value); });

      searchBtn.addEventListener("click", function () {
        var q = searchInput.value.trim();
        if (!q) return;
        setStatus("Searching…");
        var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&viewbox=-77.15,39.00,-76.90,38.79&bounded=1&q=" + encodeURIComponent(q + ", Washington, DC");
        fetch(url).then(function (r) { return r.json(); }).then(function (results) {
          if (!results.length) { setStatus("Couldn't find that address in DC — try including the street type (Ave, St, etc.)."); return; }
          var lat = parseFloat(results[0].lat), lon = parseFloat(results[0].lon);
          var feature = findSMDForPoint(lon, lat, smdGeoJSON);
          if (!feature) { setStatus("That address doesn't fall inside a known SMD."); return; }
          selectSMD(feature.properties.SMD_ID);
        }).catch(function () { setStatus("Address search failed — try the dropdown instead."); });
      });

      setStatus("");
    }).catch(function (err) {
      setStatus("Couldn't load the tool's data: " + err.message);
    });
  }

  document.querySelectorAll(".anc-tool").forEach(init);
})();
