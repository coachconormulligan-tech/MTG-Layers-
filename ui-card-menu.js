/* [KEY: CARD-MENU]
   The menu of a battlefield card: right-click the card, or the "More" button
   shown on hover (touch screens have no right-click). One item list
   (buildCardMenuItems) feeds the menu and the keyboard shortcuts, and every
   item calls a handler that already exists elsewhere (toggleTapped, flipCard,
   setFaceDown, modifyCounter, openAbilityPopup, ...): no game logic here.

   An item is { label, run } with optional { key, hint, danger }, a submenu is
   { label, children: [items] }, a divider is { sep: true }.
   ========================================================================= */

let _cardMenuActions = [];

function _cardMenuCounterTypes(perm) {
  const seen = new Set();
  const out = [];
  const add = (type, label) => {
    if (seen.has(type)) return;
    seen.add(type);
    out.push({ type, label: label || (type.charAt(0).toUpperCase() + type.slice(1)) });
  };
  for (const t of (perm.oracleCounterTypes || [])) add(t);
  for (const c of COUNTER_PRESETS) add(c.type, c.label);
  for (const p2 of Battlefield.permanents) {
    for (const t of (p2.oracleCounterTypes || [])) add(t);
  }
  return out;
}

function buildCardMenuItems(permId) {
  const p = Battlefield.getPermById(permId);
  if (!p) return [];
  const items = [];
  const sep = () => { if (items.length && !items[items.length - 1].sep) items.push({ sep: true }); };
  const remove = { label: 'Remove', danger: true, run: () => removePermanent(permId) };

  // A spell, a fired ability or an emblem is no permanent: it can only be removed.
  if (p.isManualEffect || p.isSpell || p.isEmblem) return [remove];

  const fs = Battlefield.getAllFinalStates().get(permId);
  const isCreature = fs ? (fs.types || []).includes('Creature') : (p.printedTypes || []).includes('Creature');
  const traits = p.traits || [];

  items.push({ label: 'Analyze', run: () => openAnalyzeAbilities(permId) });

  sep();
  items.push({ label: p.tapped ? 'Untap' : 'Tap', key: 'T', run: () => toggleTapped(permId) });
  if (p.isTransformable) items.push({ label: 'Transform', key: 'F', run: () => flipCard(permId) });
  if (p.isChooseableFace) items.push({ label: 'Choose half', run: () => openDualOptionsPopup(permId) });
  if (p.isRoom && p.roomFaces) items.push({ label: 'Room options', run: () => openDualOptionsPopup(permId) });
  if (p.isFaceDown) {
    items.push({ label: 'Turn face up', run: () => turnFaceUp(permId) });
  } else {
    items.push({ label: 'Turn face down', children: [
      { label: 'Morph', hint: '2/2 creature, no abilities', run: () => setFaceDown(permId, 'morph') },
      { label: 'Manifest', hint: '2/2 creature, no abilities', run: () => setFaceDown(permId, 'manifest') },
      { label: 'Cloak', hint: '2/2 creature, ward {2}', run: () => setFaceDown(permId, 'cloak') },
    ] });
  }

  if (isCreature) {
    sep();
    items.push({ label: traits.includes('Attacking') ? 'Remove attacking' : 'Mark as attacking', key: 'A', run: () => toggleAttacking(permId) });
    items.push({ label: traits.includes('Blocking') ? 'Remove blocking' : 'Mark as blocking', key: 'B', run: () => toggleBlocking(permId) });
  }

  sep();
  items.push({ label: 'Add a counter', children: _cardMenuCounterTypes(p).map(c => (
    { label: c.label, run: () => modifyCounter(permId, c.type, 1) }
  )) });
  const present = Object.entries(p.counters || {}).filter(([, n]) => n > 0);
  if (present.length) {
    items.push({ label: 'Remove a counter', children: present.map(([type, n]) => (
      { label: type.charAt(0).toUpperCase() + type.slice(1), hint: 'x' + n, run: () => modifyCounter(permId, type, -1) }
    )) });
  }

  // What the timestamp panel offers for this card, offered here too.
  sep();
  if (fs) {
    const n = Battlefield.extractTriggeredAbilities(fs.abilities || []).length
            + Battlefield.extractActivatedAbilities(fs.abilities || []).length;
    if (n) items.push({ label: 'Abilities (' + n + ')', run: () => openAbilityPopup(permId) });
  }
  const eff = getEffectInfo(permId, fs);
  if (eff.hasCopyToken) items.push({ label: 'Choose what it copies', run: () => openCopyModal(permId) });
  if (eff.hasText && eff.textChangeType !== 'volrath_text') items.push({ label: 'Edit text change', run: () => openTextChangeModal(permId) });
  if (eff.hasExchangeControl) items.push({ label: 'Exchange control', run: () => openExchangeControlModal(permId) });
  const notCopyCard = !_isNonTokenCopyCard(p);
  if (p.hasMutate && notCopyCard) items.push({ label: 'Mutate', run: () => openMutateModal(permId) });
  const stack = Battlefield.getStack(permId);
  if (stack && stack.filter(id => Battlefield.getPermById(id)).length >= 2) {
    items.push({ label: 'Remove from mutate stack', run: () => removeMutate(permId) });
  }
  if (p.hasBestow && notCopyCard) items.push({ label: 'Bestow', run: () => openBestowModal(permId) });
  if (Battlefield.getBestowTarget(permId)) items.push({ label: 'Remove bestow', run: () => removeBestow(permId) });

  sep();
  items.push(remove);
  return items;
}

function closeCardMenu() {
  const menu = document.getElementById('card-menu');
  if (!menu) return false;
  if (menu._close) {
    document.removeEventListener('click', menu._close, true);
    document.removeEventListener('contextmenu', menu._close, true);
  }
  menu.remove();
  _cardMenuActions = [];
  return true;
}

function _cardMenuClamp(menu, x, y) {
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function openCardMenu(event, permId) {
  closeCardMenu();
  const perm = Battlefield.getPermById(permId);
  if (!perm) return;
  if (Battlefield.inspectedId !== permId) selectInspected(permId);

  _cardMenuActions = [];
  const renderItem = (it) => {
    if (it.sep) return '<div class="card-menu-sep"></div>';
    if (it.children) {
      return `<div class="card-menu-group">
        <button class="card-menu-item card-menu-parent" onclick="_cardMenuToggleGroup(this)" aria-expanded="false">
          <span class="card-menu-label">${escapeHtml(it.label)}</span><span class="card-menu-key">More</span>
        </button>
        <div class="card-menu-sub">${it.children.map(renderItem).join('')}</div>
      </div>`;
    }
    const i = _cardMenuActions.push(it.run) - 1;
    return `<button class="card-menu-item${it.danger ? ' card-menu-danger' : ''}" onclick="_cardMenuRun(${i})">
      <span class="card-menu-label">${escapeHtml(it.label)}${it.hint ? `<span class="card-menu-hint">${escapeHtml(it.hint)}</span>` : ''}</span>${it.key ? `<kbd class="card-menu-key">${escapeHtml(it.key)}</kbd>` : ''}
    </button>`;
  };

  const menu = document.createElement('div');
  menu.id = 'card-menu';
  menu.className = 'card-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="card-menu-title">${escapeHtml(perm.name)}${perm.label ? ' ' + escapeHtml(perm.label) : ''}</div>`
    + buildCardMenuItems(permId).map(renderItem).join('');
  document.body.appendChild(menu);
  menu._x = event.clientX;
  menu._y = event.clientY;
  _cardMenuClamp(menu, menu._x, menu._y);

  menu._close = (e) => { if (!menu.contains(e.target)) closeCardMenu(); };
  setTimeout(() => {
    if (!menu.isConnected) return;
    document.addEventListener('click', menu._close, true);
    document.addEventListener('contextmenu', menu._close, true);
  }, 0);
}

function _cardMenuToggleGroup(btn) {
  const group = btn.closest('.card-menu-group');
  const open = group.classList.toggle('open');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.querySelector('.card-menu-key').textContent = open ? 'Less' : 'More';
  const menu = document.getElementById('card-menu');
  if (menu) _cardMenuClamp(menu, menu._x, menu._y);
}

function _cardMenuRun(i) {
  const run = _cardMenuActions[i];
  closeCardMenu();
  if (run) run();
}

/* Keyboard shortcuts on the inspected card: the keys shown beside the menu's
   items. Returns true when the key did something. */
function cardMenuShortcut(key) {
  const id = Battlefield.inspectedId;
  if (!id || !Battlefield.getPermById(id)) return false;
  const wanted = String(key).toUpperCase();
  const flat = [];
  for (const it of buildCardMenuItems(id)) {
    if (it.children) flat.push(...it.children); else flat.push(it);
  }
  const hit = flat.find(it => it.key === wanted);
  if (!hit) return false;
  closeCardMenu();
  hit.run();
  return true;
}
/* [END: CARD-MENU] */
