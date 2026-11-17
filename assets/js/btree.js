/* Interactive B+ tree for the staff path, lab 2.
   Textbook B+ tree: at most 3 keys per node, at least 2 except the root.
   Every key lives in a leaf. Internal nodes hold separator copies only.
   Leaves are linked in key order, so a range scan walks sideways.
   Operations run to completion and record frames (tree snapshot + a line
   of narration). The UI steps through frames, so Step and Play show the
   same moves, one at a time. No dependencies, no network. */
(function () {
  'use strict';

  var MAX_KEYS = 3;
  /* A 4-key leaf splits 2 and 2, so leaves hold at least 2 keys. A 4-key
     internal node splits 2, 1 up, 1, so internal nodes hold at least 1.
     The split point is 2 in both cases. */
  var SPLIT_AT = 2;
  var MIN_LEAF = 2;
  var MIN_INTERNAL = 1;

  var nextId = 1;
  function newNode(leaf) {
    return { id: nextId++, keys: [], children: [], leaf: !!leaf, next: null };
  }

  /* Deep copy, including the leaf chain: clones are linked in the same
     order as the original leaves, so the rendered chain is real. */
  function clone(node) {
    if (!node) { return null; }
    var byId = {};
    function rec(n) {
      var c = { id: n.id, keys: n.keys.slice(), leaf: n.leaf, children: n.children.map(rec) };
      byId[n.id] = c;
      return c;
    }
    var copy = rec(node);
    var orig = leftmostLeaf(node);
    var prev = null;
    while (orig) {
      var cc = byId[orig.id];
      if (prev) { prev.next = cc; }
      prev = cc;
      orig = orig.next;
    }
    return copy;
  }

  function leftmostLeaf(node) {
    while (!node.leaf) { node = node.children[0]; }
    return node;
  }

  function firstKey(node) {
    return leftmostLeaf(node).keys[0];
  }

  /* Walk down to the leaf a key belongs in, narrating the walk. */
  function descend(root, key, frames, note) {
    var node = root;
    while (!node.leaf) {
      var i = 0;
      while (i < node.keys.length && key >= node.keys[i]) { i++; }
      frames.push({
        tree: clone(root), node: node.id, key: null,
        text: 'At a node holding ' + node.keys.join(', ') + '. ' +
          (i < node.keys.length
            ? key + ' is smaller than ' + node.keys[i] + ', so go left.'
            : key + ' is bigger than every separator here, so go to the last child.')
      });
      node = node.children[i];
    }
    frames.push({
      tree: clone(root), node: node.id, key: null,
      text: (note || 'Reached the leaf') + ': [' + node.keys.join(', ') + '].'
    });
    return node;
  }

  /* Insert into a node. Returns {sep, node} when the node splits and the
     separator must go up to the parent, otherwise null. */
  function insertRec(node, key, frames, root) {
    var i, res, right, mid;
    if (node.leaf) {
      i = 0;
      while (i < node.keys.length && node.keys[i] < key) { i++; }
      if (node.keys[i] === key) {
        frames.push({
          tree: clone(root), node: node.id, key: key,
          text: key + ' is already in this leaf. No duplicate keys, nothing changes.'
        });
        return null;
      }
      node.keys.splice(i, 0, key);
      frames.push({
        tree: clone(root), node: node.id, key: key,
        text: key + ' slots into the leaf in sorted order: [' + node.keys.join(', ') + '].'
      });
      if (node.keys.length > MAX_KEYS) {
        right = newNode(true);
        right.keys = node.keys.slice(SPLIT_AT);
        node.keys = node.keys.slice(0, SPLIT_AT);
        right.next = node.next;
        node.next = right;
        frames.push({
          tree: clone(root), node: node.id, key: null,
          text: 'Leaf full with 4 keys, so it splits in two: [' + node.keys.join(', ') +
            '] and [' + right.keys.join(', ') + ']. A copy of ' + right.keys[0] +
            ' goes up as the separator. The leaf chain now points through both.'
        });
        return { sep: right.keys[0], node: right };
      }
      return null;
    }
    i = 0;
    while (i < node.keys.length && key >= node.keys[i]) { i++; }
    res = insertRec(node.children[i], key, frames, root);
    if (!res) { return null; }
    node.keys.splice(i, 0, res.sep);
    node.children.splice(i + 1, 0, res.node);
    if (node.keys.length > MAX_KEYS) {
      right = newNode(false);
      mid = node.keys[SPLIT_AT];
      right.keys = node.keys.slice(SPLIT_AT + 1);
      right.children = node.children.slice(SPLIT_AT + 1);
      node.keys = node.keys.slice(0, SPLIT_AT);
      node.children = node.children.slice(0, SPLIT_AT + 1);
      frames.push({
        tree: clone(root), node: node.id, key: null,
        text: 'Internal node full, so it splits. The middle key ' + mid +
          ' moves up to the parent (it does not stay behind, internal nodes hold no rows).'
      });
      return { sep: mid, node: right };
    }
    return null;
  }

  function runInsert(root, key) {
    var frames = [];
    frames.push({
      tree: clone(root), node: root.id, key: null,
      text: 'Insert ' + key + '. First, find the leaf it belongs in.'
    });
    descend(root, key, frames, 'Found the leaf for ' + key);
    var res = insertRec(root, key, frames, root);
    if (res) {
      var nr = newNode(false);
      nr.keys = [res.sep];
      nr.children = [root, res.node];
      root = nr;
      frames.push({
        tree: clone(root), node: nr.id, key: null,
        text: 'The root split, so the tree grows one level. Every leaf is still at the same depth.'
      });
    }
    frames.push({
      tree: clone(root), node: null, key: null,
      text: 'Done. Every leaf is still at the same depth. Leaves hold at least 2 keys, internal nodes at least 1, apart from the root.'
    });
    return { root: root, frames: frames };
  }

  /* Borrow from a sibling, or merge with one, to fix an underflowing child. */
  function fixChild(parent, index, frames, root) {
    var child = parent.children[index];
    var left = index > 0 ? parent.children[index - 1] : null;
    var right = index < parent.children.length - 1 ? parent.children[index + 1] : null;
    var moved, sepDown;
    var minSibling = child.leaf ? MIN_LEAF : MIN_INTERNAL;
    if (left && left.keys.length > minSibling) {
      if (child.leaf) {
        moved = left.keys.pop();
        child.keys.unshift(moved);
        parent.keys[index - 1] = child.keys[0];
        frames.push({
          tree: clone(root), node: child.id, key: moved,
          text: 'This leaf dropped below half full, so it borrows ' + moved +
            ' from the leaf on its left. The separator above is updated to ' +
            child.keys[0] + ', the new first key of this leaf.'
        });
      } else {
        sepDown = parent.keys[index - 1];
        parent.keys[index - 1] = left.keys.pop();
        child.keys.unshift(sepDown);
        child.children.unshift(left.children.pop());
        frames.push({
          tree: clone(root), node: child.id, key: null,
          text: 'This node borrows from its left neighbour: the separator moves down into it, and the neighbour\'s last key moves up to take its place.'
        });
      }
      return;
    }
    if (right && right.keys.length > minSibling) {
      if (child.leaf) {
        moved = right.keys.shift();
        child.keys.push(moved);
        parent.keys[index] = right.keys[0];
        frames.push({
          tree: clone(root), node: child.id, key: moved,
          text: 'This leaf borrows ' + moved + ' from the leaf on its right. The separator above is updated to ' +
            right.keys[0] + ', the new first key of that leaf.'
        });
      } else {
        sepDown = parent.keys[index];
        parent.keys[index] = right.keys.shift();
        child.keys.push(sepDown);
        child.children.push(right.children.shift());
        frames.push({
          tree: clone(root), node: child.id, key: null,
          text: 'This node borrows from its right neighbour: the separator moves down into it, and the neighbour\'s first key moves up to take its place.'
        });
      }
      return;
    }
    if (left) { mergeChildren(parent, index - 1, frames, root); }
    else if (right) { mergeChildren(parent, index, frames, root); }
  }

  function mergeChildren(parent, index, frames, root) {
    var left = parent.children[index];
    var right = parent.children[index + 1];
    if (left.leaf) {
      left.keys = left.keys.concat(right.keys);
      left.next = right.next;
      parent.keys.splice(index, 1);
      parent.children.splice(index + 1, 1);
      frames.push({
        tree: clone(root), node: left.id, key: null,
        text: 'Neither leaf can spare a key, so they merge into one: [' + left.keys.join(', ') +
          ']. The separator between them is dropped from the parent, and the leaf chain skips over the leaf that went away.'
      });
    } else {
      left.keys.push(parent.keys[index]);
      left.keys = left.keys.concat(right.keys);
      left.children = left.children.concat(right.children);
      parent.keys.splice(index, 1);
      parent.children.splice(index + 1, 1);
      frames.push({
        tree: clone(root), node: left.id, key: null,
        text: 'Neither node can spare a key, so they merge. The separator between them drops down into the merged node.'
      });
    }
  }

  /* In a B+ tree every separator equals the first key of the right child's
     leftmost leaf. Recompute them all after a delete, so no stale separator
     survives a borrow or a merge. */
  function repairSeparators(node) {
    if (node.leaf) { return; }
    for (var i = 0; i < node.children.length; i++) {
      repairSeparators(node.children[i]);
      if (i > 0) { node.keys[i - 1] = firstKey(node.children[i]); }
    }
  }

  /* Returns 'ok', 'underflow', or 'missing'. */
  function deleteFrom(node, key, frames, root) {
    var i, j, res;
    if (node.leaf) {
      i = node.keys.indexOf(key);
      if (i === -1) { return 'missing'; }
      node.keys.splice(i, 1);
      frames.push({
        tree: clone(root), node: node.id, key: null,
        text: key + ' is removed from the leaf. Left: [' + node.keys.join(', ') + '].'
      });
      return node.keys.length < MIN_LEAF ? 'underflow' : 'ok';
    }
    j = 0;
    while (j < node.keys.length && key >= node.keys[j]) { j++; }
    res = deleteFrom(node.children[j], key, frames, root);
    if (res === 'missing') { return 'missing'; }
    if (res === 'underflow') {
      fixChild(node, j, frames, root);
      repairSeparators(root);
      return node.keys.length < MIN_INTERNAL ? 'underflow' : 'ok';
    }
    repairSeparators(root);
    return 'ok';
  }

  function runDelete(root, key) {
    var frames = [];
    frames.push({
      tree: clone(root), node: root.id, key: null,
      text: 'Delete ' + key + '. Every key lives in a leaf, so the search always ends there.'
    });
    var leaf = descend(root, key, frames, 'Reached the leaf for ' + key);
    if (leaf.keys.indexOf(key) === -1) {
      frames.push({
        tree: clone(root), node: leaf.id, key: null,
        text: key + ' is not in this leaf, and the leaf is exactly where it would have to be. Nothing to delete.'
      });
      return { root: root, frames: frames };
    }
    if (root.leaf) {
      leaf.keys.splice(leaf.keys.indexOf(key), 1);
      frames.push({
        tree: clone(root), node: leaf.id, key: null,
        text: key + ' removed. The whole tree is one leaf: [' + leaf.keys.join(', ') + '].'
      });
      return { root: root, frames: frames };
    }
    deleteFrom(root, key, frames, root);
    repairSeparators(root);
    if (!root.leaf && root.keys.length === 0 && root.children.length === 1) {
      root = root.children[0];
      frames.push({
        tree: clone(root), node: root.id, key: null,
        text: 'The root emptied out, so the tree loses a level. Every leaf is still at the same depth.'
      });
    }
    frames.push({
      tree: clone(root), node: null, key: null,
      text: 'Done. A separator can outlive its key: it only says smaller keys go left, the rest go right, so it stays even when no leaf holds that key any more.'
    });
    return { root: root, frames: frames };
  }

  function runSearch(root, key) {
    var frames = [];
    frames.push({
      tree: clone(root), node: root.id, key: null,
      text: 'Search for ' + key + '. In a B+ tree the search always goes all the way down to a leaf.'
    });
    var leaf = descend(root, key, frames, 'Reached the leaf');
    if (leaf.keys.indexOf(key) !== -1) {
      frames.push({
        tree: clone(root), node: leaf.id, key: key,
        text: 'Found ' + key + ' in the leaf. Reads: one page per level, plus one heap page for the row. That is the whole lookup cost.'
      });
    } else {
      frames.push({
        tree: clone(root), node: leaf.id, key: null,
        text: key + ' is not in this leaf, and this leaf is exactly where it would have to be. Same number of reads as a hit: one page per level.'
      });
    }
    return { root: root, frames: frames };
  }

  function runRange(root, lo, hi) {
    var frames = [];
    frames.push({
      tree: clone(root), node: root.id, key: null,
      text: 'Range scan from ' + lo + ' to ' + hi + '. First, descend once to the leaf where ' + lo + ' would be.'
    });
    var leaf = descend(root, lo, frames, 'Reached the starting leaf');
    var seen = [];
    var guard = 0;
    while (leaf && guard < 100) {
      guard++;
      var hitAny = false;
      for (var i = 0; i < leaf.keys.length; i++) {
        var k = leaf.keys[i];
        if (k >= lo && k <= hi) { seen.push(k); hitAny = true; }
      }
      frames.push({
        tree: clone(root), node: leaf.id, key: null,
        text: 'Leaf [' + leaf.keys.join(', ') + ']: ' +
          (hitAny ? 'keys in range so far: ' + seen.join(', ') + '.' : 'nothing in range here.') +
          (leaf.next ? ' Follow the leaf pointer to the next leaf.' : ' End of the chain.')
      });
      if (!leaf.next) { break; }
      if (leaf.next.keys[0] > hi) { break; }
      leaf = leaf.next;
    }
    frames.push({
      tree: clone(root), node: null, key: null,
      text: seen.length
        ? 'Range scan done: ' + seen.length + ' keys (' + seen.join(', ') + '). One descent, then sideways along the leaf chain. No climbing back up.'
        : 'No keys in that range. The scan still cost one descent plus the leaves it checked.'
    });
    return { root: root, frames: frames };
  }

  /* ---- validation, used by the node test harness ---- */
  function validate(root) {
    var leaves = [];
    var problems = [];
    function walk(node, depth) {
      if (node.leaf) {
        if (node !== root && node.keys.length < MIN_LEAF) { problems.push('leaf ' + node.id + ' underfull'); }
        leaves.push({ node: node, depth: depth });
        return;
      }
      if (node.keys.length > MAX_KEYS) { problems.push('node ' + node.id + ' has ' + node.keys.length + ' keys'); }
      if (node !== root && node.keys.length < MIN_INTERNAL) { problems.push('node ' + node.id + ' underfull'); }
      if (node.children.length !== node.keys.length + 1) { problems.push('node ' + node.id + ' children mismatch'); }
      for (var i = 0; i < node.children.length; i++) {
        if (i > 0) {
          var fk = firstKey(node.children[i]);
          if (node.keys[i - 1] !== fk) { problems.push('separator ' + node.keys[i - 1] + ' should be ' + fk); }
        }
        walk(node.children[i], depth + 1);
      }
    }
    walk(root, 0);
    var depths = leaves.map(function (l) { return l.depth; });
    if (Math.max.apply(null, depths) !== Math.min.apply(null, depths)) { problems.push('leaves at different depths'); }
    var all = [];
    var cur = leftmostLeaf(root);
    while (cur) {
      for (var i = 0; i < cur.keys.length; i++) { all.push(cur.keys[i]); }
      cur = cur.next;
    }
    for (var j = 1; j < all.length; j++) {
      if (all[j] <= all[j - 1]) { problems.push('keys out of order at ' + all[j]); }
    }
    return problems;
  }

  function buildDemo() {
    var root = newNode(true);
    root.keys = [10, 25, 87];
    return root;
  }

  var api = {
    buildDemo: buildDemo,
    runSearch: runSearch,
    runInsert: runInsert,
    runDelete: runDelete,
    runRange: runRange,
    validate: validate,
    clone: clone
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (typeof window !== 'undefined') { window.__btree = api; }

  /* ---- browser UI ---- */
  if (typeof document === 'undefined' || !document.getElementById || !document.getElementById('btreeWidget')) { return; }

  var widget = document.getElementById('btreeWidget');
  var treeEl = document.getElementById('btreeTree');
  var statusEl = document.getElementById('btreeStatus');
  var keyInput = document.getElementById('btreeKey');
  var loInput = document.getElementById('btreeLo');
  var hiInput = document.getElementById('btreeHi');
  var speedSel = document.getElementById('btreeSpeed');
  var noteEl = document.getElementById('btreeNote');
  var countEl = document.getElementById('btreeCount');
  if (!treeEl || !statusEl || !keyInput) { return; }

  var SPEEDS = { slow: 1200, normal: 700, fast: 350 };
  var root = buildDemo();
  var frames = [];
  var frameIdx = -1;
  var timer = null;
  var engine = 'pg';

  var NOTES = {
    pg: 'PostgreSQL: a modified B+ tree. Internal nodes are linked too, so many sessions can read and write at once. A leaf entry is (key, heap pointer): the row itself lives in the heap file, base/16384/16397.',
    my: 'MySQL · InnoDB: a textbook B+ tree, clustered. A leaf entry is the full row: the table IS the tree, inside users.ibd. A secondary index leaf holds (key, primary key), so a lookup by name hops index, then clustered row.'
  };

  function setStatus(text) { statusEl.textContent = text; }

  function renderTree(tree, hlNode, hlKey) {
    function nodeHtml(node) {
      var cls = 'bnode' + (node.leaf ? ' leaf' : '');
      if (hlNode === node.id) { cls += ' cur'; }
      var spans = node.keys.map(function (k) {
        var c = (hlKey === k && hlNode === node.id) ? ' class="hit"' : '';
        return '<span' + c + '>' + k + '</span>';
      }).join('');
      return '<div class="' + cls + '">' + spans + '</div>';
    }
    function levels(node, depth, rows) {
      rows[depth] = rows[depth] || [];
      rows[depth].push(nodeHtml(node));
      if (!node.leaf) {
        for (var i = 0; i < node.children.length; i++) { levels(node.children[i], depth + 1, rows); }
      }
    }
    var rows = [];
    levels(tree, 0, rows);
    var leafRow = [];
    var leaf = leftmostLeaf(tree);
    while (leaf) {
      leafRow.push(nodeHtml(leaf));
      leaf = leaf.next;
    }
    var html = rows.map(function (r) {
      return '<div class="brow">' + r.join('') + '</div>';
    }).join('');
    if (rows.length > 1) {
      html += '<div class="bt-chain"><p class="dcap">Leaves, linked in key order</p><div class="brow bt-leaves">' +
        leafRow.join('<span class="darrow">→</span>') + '</div></div>';
    }
    treeEl.innerHTML = html;
    var count = 0;
    var l2 = leftmostLeaf(tree);
    while (l2) { count += l2.keys.length; l2 = l2.next; }
    if (countEl) { countEl.textContent = count + ' keys in ' + rows.length + ' level' + (rows.length === 1 ? '' : 's'); }
  }

  function showFrame(i) {
    frameIdx = i;
    var f = frames[i];
    renderTree(f.tree, f.node, f.key);
    setStatus((i + 1) + ' / ' + frames.length + '. ' + f.text);
  }

  function stopPlay() {
    if (timer) { clearInterval(timer); timer = null; }
    var pb = document.getElementById('btreePlay');
    if (pb) { pb.textContent = '▶ Play'; }
  }

  function runOp(fn) {
    stopPlay();
    var res = fn();
    root = res.root;
    frames = res.frames;
    if (!frames.length) { return; }
    showFrame(0);
    var pb = document.getElementById('btreePlay');
    if (pb) { pb.disabled = false; }
    var sb = document.getElementById('btreeStep');
    if (sb) { sb.disabled = false; }
  }

  function readKey() {
    var v = parseInt(keyInput.value, 10);
    if (isNaN(v)) { setStatus('Type a key first.'); return null; }
    return v;
  }

  function bind(id, fn) {
    var el = document.getElementById(id);
    if (el) { el.addEventListener('click', fn); }
  }

  bind('btreeSearch', function () {
    var k = readKey(); if (k === null) { return; }
    runOp(function () { return runSearch(root, k); });
  });
  bind('btreeInsert', function () {
    var k = readKey(); if (k === null) { return; }
    runOp(function () { return runInsert(root, k); });
  });
  bind('btreeDelete', function () {
    var k = readKey(); if (k === null) { return; }
    runOp(function () { return runDelete(root, k); });
  });
  bind('btreeRange', function () {
    var lo = parseInt(loInput.value, 10);
    var hi = parseInt(hiInput.value, 10);
    if (isNaN(lo) || isNaN(hi) || lo > hi) { setStatus('Range needs two numbers, low first.'); return; }
    runOp(function () { return runRange(root, lo, hi); });
  });
  bind('btreeStep', function () {
    stopPlay();
    if (!frames.length) { setStatus('Run Search, Insert, Delete, or a Range scan first.'); return; }
    if (frameIdx < frames.length - 1) { showFrame(frameIdx + 1); }
    else { setStatus('End of this operation. Run another one, or press Reset.'); }
  });
  bind('btreePlay', function () {
    if (!frames.length) { setStatus('Run Search, Insert, Delete, or a Range scan first.'); return; }
    if (timer) { stopPlay(); return; }
    var btn = document.getElementById('btreePlay');
    if (btn) { btn.textContent = '⏸ Pause'; }
    if (frameIdx >= frames.length - 1) { showFrame(0); }
    var speed = SPEEDS[speedSel ? speedSel.value : 'normal'] || 700;
    timer = setInterval(function () {
      if (frameIdx >= frames.length - 1) { stopPlay(); return; }
      showFrame(frameIdx + 1);
    }, speed);
  });
  bind('btreeReset', function () {
    stopPlay();
    root = buildDemo();
    frames = [];
    frameIdx = -1;
    renderTree(root, null, null);
    setStatus('Back to the users table: 10, 25, 87 in one leaf. Insert 42, the row from the walkthrough, then keep going until the leaf splits.');
  });
  bind('btreeDemo', function () {
    stopPlay();
    var keys = [5, 12, 15, 18, 27, 30, 33, 42, 48, 61, 69, 72, 99];
    for (var i = 0; i < keys.length; i++) {
      root = runInsert(root, keys[i]).root;
    }
    frames = [];
    frameIdx = -1;
    renderTree(root, null, null);
    setStatus('Demo set loaded: 16 keys in 3 levels. Now search for 42, delete 48, or scan 30 to 70 and step through it.');
  });

  var seg = document.getElementById('btreeSeg');
  if (seg) {
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) { return; }
      seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
      b.setAttribute('aria-pressed', 'true');
      engine = b.getAttribute('data-e');
      if (noteEl) { noteEl.textContent = NOTES[engine]; }
      widget.classList.toggle('bt-mysql', engine === 'my');
    });
  }

  renderTree(root, null, null);
  setStatus('The users table: 10, 25, 87 in one leaf. Insert 42, the row from the walkthrough, then keep going until the leaf splits.');
})();
