(function () {
  'use strict';

  var NODE_TYPES = [
    'Parallel Seq Scan',
    'Bitmap Heap Scan',
    'Bitmap Index Scan',
    'Index Only Scan',
    'Index Scan',
    'Seq Scan',
    'Nested Loop',
    'Hash Join',
    'Merge Join',
    'HashAggregate',
    'GroupAggregate',
    'Memoize',
    'Materialize',
    'Gather Merge',
    'Gather',
    'Unique',
    'WindowAgg',
    'CTE Scan',
    'Function Scan',
    'Values Scan',
    'Foreign Scan',
    'Sample Scan',
    'Subquery Scan',
    'ProjectSet',
    'ModifyTable',
    'Sort',
    'Limit',
    'Hash',
    'Append',
    'Result',
    'Aggregate',
    'Tid Scan',
    'Insert',
    'Update',
    'Delete'
  ];

  var SAMPLE = [
    'Nested Loop  (cost=0.43..123.45 rows=10 width=32) (actual time=0.050..12.340 rows=10 loops=1)',
    '  Buffers: shared hit=120 read=5',
    '  ->  Index Scan using users_pkey on users  (cost=0.43..8.44 rows=1 width=16) (actual time=0.020..0.030 rows=1 loops=1)',
    '        Index Cond: (id = 7)',
    '        Buffers: shared hit=4 read=0',
    '  ->  Seq Scan on orders  (cost=0.00..100.00 rows=10 width=16) (actual time=0.010..12.000 rows=4800 loops=1)',
    '        Filter: (user_id = 7)',
    '        Rows Removed by Filter: 12000',
    '        Buffers: shared hit=100 read=5',
    'Planning Time: 0.120 ms',
    'Execution Time: 12.400 ms'
  ].join('\n');

  function parseNumber(value) {
    if (value === undefined || value === null) {
      return null;
    }
    var n = parseFloat(value);
    if (isNaN(n)) {
      return null;
    }
    return n;
  }

  function parseIntValue(value) {
    if (value === undefined || value === null) {
      return null;
    }
    var n = parseInt(value, 10);
    if (isNaN(n)) {
      return null;
    }
    return n;
  }

  function parseBuffers(text, node) {
    var hit = text.match(/hit=(\d+)/);
    var read = text.match(/read=(\d+)/);
    if (hit) {
      node.buffers.hit = parseIntValue(hit[1]);
    }
    if (read) {
      node.buffers.read = parseIntValue(read[1]);
    }
  }

  function findNodeType(text) {
    var i;
    for (i = 0; i < NODE_TYPES.length; i++) {
      if (text === NODE_TYPES[i] || text.indexOf(NODE_TYPES[i] + ' ') === 0 || text.indexOf(NODE_TYPES[i] + '  ') === 0 || text.indexOf(NODE_TYPES[i] + ' (') === 0) {
        return NODE_TYPES[i];
      }
    }
    return null;
  }

  function parsePlan(text) {
    var result = {
      nodes: [],
      roots: [],
      totalTime: 0,
      planningTime: null,
      executionTime: null,
      hasActual: false,
      globalBuffers: { hit: null, read: null }
    };
    if (!text || typeof text !== 'string') {
      return result;
    }
    var lines = text.split(/\r?\n/);
    var stack = [];
    var i;
    var line;
    var trimmed;
    var indent;
    var afterArrow;
    var nodeType;
    var node;
    var m;
    var parent;

    for (i = 0; i < lines.length; i++) {
      line = lines[i];
      if (!line || !line.trim()) {
        continue;
      }
      trimmed = line.trim();

      m = trimmed.match(/^Planning Time:\s*([\d.]+)\s*ms/);
      if (m) {
        result.planningTime = parseNumber(m[1]);
        continue;
      }
      m = trimmed.match(/^Execution Time:\s*([\d.]+)\s*ms/);
      if (m) {
        result.executionTime = parseNumber(m[1]);
        continue;
      }
      if (/^JIT:/.test(trimmed) || /^Settings:/.test(trimmed) || /^Planning:/.test(trimmed) || /^Trigger /.test(trimmed)) {
        continue;
      }

      indent = line.search(/\S/);
      if (indent < 0) {
        indent = 0;
      }
      afterArrow = trimmed.replace(/^->\s*/, '');

      nodeType = null;
      if (afterArrow.indexOf('(cost=') !== -1 || afterArrow.indexOf(' (cost=') !== -1) {
        nodeType = findNodeType(afterArrow);
        if (!nodeType) {
          m = afterArrow.match(/^(.+?)\s+\(cost=/);
          if (m) {
            nodeType = m[1].trim();
            nodeType = nodeType.replace(/\s+using\s+\S+\s+on\s+\S+.*$/, '');
            nodeType = nodeType.replace(/\s+on\s+\S+.*$/, '');
          }
        }
      }

      if (nodeType) {
        node = {
          type: nodeType,
          relation: null,
          index: null,
          startupCost: null,
          totalCost: null,
          estRows: null,
          actualRows: null,
          actualStart: null,
          actualEnd: null,
          loops: 1,
          indent: indent,
          children: [],
          buffers: { hit: null, read: null },
          sortMethod: null,
          joinFilter: null,
          filter: null,
          rowsRemoved: null,
          heapFetches: null,
          inclusiveTime: 0,
          selfTime: 0,
          share: 0,
          costShare: 0,
          flags: []
        };

        m = afterArrow.match(/ using ([^\s]+) on ([^\s]+)/);
        if (m) {
          node.index = m[1];
          node.relation = m[2];
        } else {
          m = afterArrow.match(/ on ([^\s]+)/);
          if (m) {
            node.relation = m[1];
          }
        }

        m = afterArrow.match(/cost=([\d.]+)\.\.([\d.]+)/);
        if (m) {
          node.startupCost = parseNumber(m[1]);
          node.totalCost = parseNumber(m[2]);
        }
        m = afterArrow.match(/rows=(\d+)/);
        if (m) {
          node.estRows = parseIntValue(m[1]);
        }
        m = afterArrow.match(/actual time=([\d.]+)\.\.([\d.]+) rows=(\d+) loops=(\d+)/);
        if (m) {
          node.actualStart = parseNumber(m[1]);
          node.actualEnd = parseNumber(m[2]);
          node.actualRows = parseIntValue(m[3]);
          node.loops = parseIntValue(m[4]) || 1;
          result.hasActual = true;
        }
        if (afterArrow.indexOf('Buffers:') !== -1) {
          parseBuffers(afterArrow, node);
        }

        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
          stack.pop();
        }
        if (stack.length > 0) {
          parent = stack[stack.length - 1].node;
          parent.children.push(node);
        } else {
          result.roots.push(node);
        }
        result.nodes.push(node);
        stack.push({ node: node, indent: indent });
        continue;
      }

      if (stack.length > 0 && indent > stack[stack.length - 1].indent) {
        node = stack[stack.length - 1].node;
        if (trimmed.indexOf('Buffers:') === 0) {
          parseBuffers(trimmed, node);
          continue;
        }
        m = trimmed.match(/^Sort Method:\s*(.+)$/);
        if (m) {
          node.sortMethod = m[1].trim();
          continue;
        }
        m = trimmed.match(/^Join Filter:\s*(.+)$/);
        if (m) {
          node.joinFilter = m[1].trim();
          continue;
        }
        m = trimmed.match(/^Rows Removed by Filter:\s*(\d+)/);
        if (m) {
          node.rowsRemoved = parseIntValue(m[1]);
          continue;
        }
        m = trimmed.match(/^Heap Fetches:\s*(\d+)/);
        if (m) {
          node.heapFetches = parseIntValue(m[1]);
          continue;
        }
        m = trimmed.match(/^Filter:\s*(.+)$/);
        if (m) {
          node.filter = m[1].trim();
          continue;
        }
        if (trimmed.indexOf('Buffers:') !== -1) {
          parseBuffers(trimmed, node);
          continue;
        }
      } else if (trimmed.indexOf('Buffers:') === 0) {
        m = trimmed.match(/hit=(\d+)/);
        if (m) {
          result.globalBuffers.hit = parseIntValue(m[1]);
        }
        m = trimmed.match(/read=(\d+)/);
        if (m) {
          result.globalBuffers.read = parseIntValue(m[1]);
        }
      }
    }

    if (result.executionTime !== null && result.executionTime > 0) {
      result.totalTime = result.executionTime;
    } else if (result.roots.length > 0 && result.roots[0].actualEnd !== null) {
      result.totalTime = result.roots[0].actualEnd * (result.roots[0].loops || 1);
    } else {
      result.totalTime = 0;
    }

    var j;
    var child;
    for (i = result.nodes.length - 1; i >= 0; i--) {
      node = result.nodes[i];
      if (node.actualEnd !== null) {
        node.inclusiveTime = node.actualEnd * (node.loops || 1);
      } else {
        node.inclusiveTime = 0;
      }
      node.selfTime = node.inclusiveTime;
      for (j = 0; j < node.children.length; j++) {
        child = node.children[j];
        node.selfTime -= child.inclusiveTime;
      }
      if (node.selfTime < 0) {
        node.selfTime = 0;
      }
      if (result.totalTime > 0) {
        node.share = node.selfTime / result.totalTime;
      } else {
        node.share = 0;
      }
    }

    if (result.roots.length > 0 && result.roots[0].totalCost) {
      for (i = 0; i < result.nodes.length; i++) {
        node = result.nodes[i];
        if (node.totalCost !== null) {
          node.costShare = node.totalCost / result.roots[0].totalCost;
        }
      }
    }

    for (i = 0; i < result.nodes.length; i++) {
      node = result.nodes[i];
      node.flags = buildFlags(node, result);
    }

    return result;
  }

  function buildFlags(node, result) {
    var flags = [];
    var ratio;
    var inner;
    var innerRows;
    var k;

    if (node.type === 'Seq Scan') {
      flags.push({
        text: 'Check how big this table is, because a Seq Scan on a large table reads every page.',
        links: [
          { href: '../staff-path/index.html#lvl2', label: 'Staff path level 2' },
          { href: '../start-here/index.html#hurting', label: 'What hurts' }
        ]
      });
    }

    if (node.estRows !== null && node.actualRows !== null && node.estRows > 0 && node.actualRows > 0) {
      ratio = node.actualRows / node.estRows;
      if (ratio > 10 || ratio < 0.1) {
        flags.push({
          text: 'The row estimate is off by more than 10x, so run ANALYZE first because the statistics look stale.',
          links: [
            { href: '../staff-path/index.html#lvl2', label: 'Staff path level 2' }
          ]
        });
      }
    }

    if (node.type === 'Sort' && node.sortMethod && node.sortMethod.indexOf('external merge Disk') !== -1) {
      flags.push({
        text: 'This sort spilled to disk instead of sorting in memory.',
        links: [
          { href: '../reference/index.html#evidence', label: 'Reference evidence' }
        ]
      });
    }

    if (node.buffers.read !== null && node.buffers.hit !== null && node.buffers.read > node.buffers.hit) {
      flags.push({
        text: 'Reads are higher than hits, so the working set does not fit in shared_buffers.',
        links: [
          { href: '../staff-path/index.html#lvl1', label: 'Staff path level 1' }
        ]
      });
    }

    if (node.type === 'Index Only Scan' && node.heapFetches !== null && node.heapFetches > 0) {
      flags.push({
        text: 'Heap fetches above zero mean the visibility map is stale.',
        links: [
          { href: '../staff-path/index.html#lvl3', label: 'Staff path level 3' }
        ]
      });
    }

    if (node.type === 'Nested Loop' && node.children.length > 1) {
      inner = node.children[1];
      innerRows = 0;
      if (inner.actualRows !== null) {
        innerRows = inner.actualRows * (inner.loops || 1);
      }
      if (innerRows > 1000) {
        flags.push({
          text: 'The inner side returns many rows, so check that it is indexed.',
          links: [
            { href: '../staff-path/index.html#lvl2', label: 'Staff path level 2' }
          ]
        });
      }
      for (k = 0; k < node.children.length; k++) {
        if (node.children[k].actualRows !== null && node.children[k].actualRows > 1000 && k > 0) {
          break;
        }
      }
    }

    return flags;
  }

  function formatMs(value) {
    if (value === null || value === undefined || isNaN(value)) {
      return 'n/a';
    }
    return value.toFixed(3) + ' ms';
  }

  function formatShare(value) {
    if (!value || isNaN(value)) {
      return '0%';
    }
    return Math.round(value * 100) + '%';
  }

  function makeEl(doc, tag, className, text) {
    var el = doc.createElement(tag);
    if (className) {
      el.className = className;
    }
    if (text !== undefined && text !== null) {
      el.textContent = text;
    }
    return el;
  }

  function renderResults(doc, outEl, result) {
    while (outEl.firstChild) {
      outEl.removeChild(outEl.firstChild);
    }

    var summary = makeEl(doc, 'p', '', null);
    if (result.executionTime !== null) {
      summary.textContent = 'Total time: ' + formatMs(result.executionTime) + '. Nodes: ' + result.nodes.length + '.';
    } else if (result.totalTime > 0) {
      summary.textContent = 'Total time: ' + formatMs(result.totalTime) + '. Nodes: ' + result.nodes.length + '.';
    } else {
      summary.textContent = 'No actual times in this plan, so times are shown from cost. Nodes: ' + result.nodes.length + '.';
    }
    if (result.planningTime !== null) {
      summary.textContent += ' Planning time: ' + formatMs(result.planningTime) + '.';
    }
    outEl.appendChild(summary);

    var sorted = result.nodes.slice();
    if (result.hasActual) {
      sorted.sort(function (a, b) {
        return b.selfTime - a.selfTime;
      });
    } else {
      sorted.sort(function (a, b) {
        return (b.totalCost || 0) - (a.totalCost || 0);
      });
    }

    var flagCount = 0;
    var i;
    for (i = 0; i < result.nodes.length; i++) {
      flagCount += result.nodes[i].flags.length;
    }
    if (flagCount > 0) {
      var flagNote = makeEl(doc, 'p', '', 'Flags: ' + flagCount + ' thing' + (flagCount === 1 ? '' : 's') + ' to check below.');
      outEl.appendChild(flagNote);
    }

    var list = makeEl(doc, 'div', '', null);
    outEl.appendChild(list);

    for (i = 0; i < sorted.length; i++) {
      var node = sorted[i];
      var share = result.hasActual ? node.share : node.costShare;
      var cls = 'plan-node plan-fast';
      if (share >= 0.3) {
        cls = 'plan-node plan-slow';
      } else if (share >= 0.05) {
        cls = 'plan-node plan-med';
      }
      var box = makeEl(doc, 'div', cls, null);

      var title = node.type;
      if (node.relation) {
        title += ' on ' + node.relation;
      }
      if (node.index) {
        title += ' using ' + node.index;
      }
      var head = makeEl(doc, 'p', '', title);
      box.appendChild(head);

      var barWrap = makeEl(doc, 'div', '', null);
      barWrap.setAttribute('style', 'background: #eee; height: 8px;');
      var bar = makeEl(doc, 'div', '', null);
      var pct = Math.max(0, Math.min(100, Math.round(share * 100)));
      bar.setAttribute('style', 'height: 8px; width: ' + pct + '%; background: #888;');
      barWrap.appendChild(bar);
      box.appendChild(barWrap);

      var details = [];
      if (node.startupCost !== null && node.totalCost !== null) {
        details.push('Cost ' + node.startupCost + '..' + node.totalCost);
      }
      if (node.estRows !== null) {
        details.push('Estimated rows ' + node.estRows);
      }
      if (node.actualRows !== null) {
        details.push('Actual rows ' + node.actualRows);
      }
      if (node.loops !== null) {
        details.push('Loops ' + node.loops);
      }
      if (node.actualEnd !== null) {
        details.push('Actual time ' + formatMs(node.actualStart) + ' to ' + formatMs(node.actualEnd));
        details.push('Self time ' + formatMs(node.selfTime) + ' (' + formatShare(node.share) + ' of total)');
      } else if (node.totalCost !== null) {
        details.push('Cost share ' + formatShare(node.costShare));
      }
      if (node.buffers.hit !== null || node.buffers.read !== null) {
        details.push('Buffers shared hit=' + (node.buffers.hit === null ? 0 : node.buffers.hit) + ' read=' + (node.buffers.read === null ? 0 : node.buffers.read));
      }
      if (node.sortMethod) {
        details.push('Sort Method: ' + node.sortMethod);
      }
      if (node.joinFilter) {
        details.push('Join Filter: ' + node.joinFilter);
      }
      if (node.rowsRemoved !== null) {
        details.push('Rows Removed by Filter: ' + node.rowsRemoved);
      }
      if (node.heapFetches !== null) {
        details.push('Heap Fetches: ' + node.heapFetches);
      }
      var detailEl = makeEl(doc, 'p', '', details.join(' | '));
      box.appendChild(detailEl);

      var f;
      var j;
      for (j = 0; j < node.flags.length; j++) {
        f = node.flags[j];
        var flagEl = makeEl(doc, 'p', '', null);
        flagEl.textContent = f.text + ' ';
        for (var k = 0; k < f.links.length; k++) {
          var a = makeEl(doc, 'a', '', f.links[k].label);
          a.setAttribute('href', f.links[k].href);
          flagEl.appendChild(a);
          if (k < f.links.length - 1) {
            flagEl.appendChild(doc.createTextNode(' '));
          }
        }
        box.appendChild(flagEl);
      }

      list.appendChild(box);
    }
  }

  function showMessage(doc, outEl, message) {
    while (outEl.firstChild) {
      outEl.removeChild(outEl.firstChild);
    }
    var p = makeEl(doc, 'p', '', message);
    outEl.appendChild(p);
  }

  if (typeof window !== 'undefined') {
    window.__explainTool = { parsePlan: parsePlan, SAMPLE: SAMPLE, buildFlags: buildFlags };
  }

  if (typeof document === 'undefined' || !document.getElementById || !document.getElementById('explainTool')) {
    return;
  }

  var input = document.getElementById('planInput');
  var analyzeBtn = document.getElementById('planAnalyze');
  var sampleBtn = document.getElementById('planSample');
  var outEl = document.getElementById('planOut');

  if (!input || !analyzeBtn || !sampleBtn || !outEl) {
    return;
  }

  analyzeBtn.addEventListener('click', function () {
    var text = input.value || '';
    if (!text.trim()) {
      showMessage(document, outEl, 'Paste a plan first.');
      return;
    }
    var result;
    try {
      result = parsePlan(text);
    } catch (e) {
      showMessage(document, outEl, 'I could not read this as an EXPLAIN ANALYZE plan. Paste the text output, starting with a node line like Seq Scan or Index Scan.');
      return;
    }
    if (!result || !result.nodes || result.nodes.length === 0) {
      showMessage(document, outEl, 'I could not read this as an EXPLAIN ANALYZE plan. Paste the text output, starting with a node line like Seq Scan or Index Scan.');
      return;
    }
    try {
      renderResults(document, outEl, result);
    } catch (e) {
      showMessage(document, outEl, 'I could not read this as an EXPLAIN ANALYZE plan. Paste the text output, starting with a node line like Seq Scan or Index Scan.');
    }
  });

  sampleBtn.addEventListener('click', function () {
    input.value = SAMPLE;
    input.focus();
  });
})();
