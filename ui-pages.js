const UTILITY_PAGES = new Set(['tutorial', 'about', 'contact']);

/* Tutorial scenarios. Each `file` is a serialized board (Battlefield.serialize
   format) living in assets/Scenarios/; the Build button fetches it and restores
   the board exactly as the Import-board flow does. Keep this list in the same
   order as the files — the displayed "Scenario N" number is the array index + 1. */
const TUTORIAL_SCENARIOS = [
  { file: 'Scenario 1.json', desc: `Player 1 controls a Volrath's Shapeshifter. The top card of his graveyard is Kenrith, the Returned King. Player 2 controls a Llanowar Elves, then casts Exchange of Words, targeting Llanowar Elves and Volrath's Shapeshifter. What is Volrath's Shapeshifter's base power and toughness?` },
  { file: 'Scenario 2.json', desc: `Player 1 controls a Purphoros, God of the Forge. Devotion to red is currently four. Player 2 plays a Curious Colossus, targeting Player 1 with the ability. After that resolves, Player 1 plays a Siege Gang Commander. What is Purphoros' type, and does it have any abilities?` },
  { file: 'Scenario 3.json', desc: `Player 1 controls a Purphoros, God of the Forge. Devotion to red is currently five. Player 2 plays a Curious Colossus, targeting Player 1 with the ability. After that resolves, Player 1's devotion drops to four. What is Purphoros' type, and does it have any abilities?` },
  { file: 'Scenario 4.json', desc: `Player 1 has a Conversion, Blood Moon, Life and Limb, and a Saproling Token that entered play in that order. What are the types of the Saproling Token?` },
  { file: 'Scenario 5.json', desc: `Building off of Scenario 4, what happens to the Saproling token if you then play a Stomping Ground?` },
  { file: 'Scenario 6.json', desc: `Building off of Scenario 4, what happens to the Saproling token if you then play a Watery Grave?` },
];

document.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('hashchange', renderUtilityRoute);
  renderUtilityRoute();

  const shell = document.getElementById('utility-page-shell');
  if (shell) {
    shell.addEventListener('click', e => {
      const videoBtn = e.target.closest('.tutorial-video-btn');
      if (videoBtn) { openVideoModal(videoBtn.dataset.src, videoBtn.dataset.label); return; }

      const buildBtn = e.target.closest('.scenario-build-btn');
      if (buildBtn) buildScenario(buildBtn.dataset.file, buildBtn);
    });
  }
});

/* Fetch a scenario board file and restore it, then return to the battlefield.
   Mirrors importBoard() in ui-core.js (parse → _restoreFromData → renderAll). */
async function buildScenario(file, btn) {
  if (!file) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
  try {
    const res = await fetch('assets/Scenarios/' + encodeURIComponent(file), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (typeof _restoreFromData !== 'function' || !_restoreFromData(data)) {
      throw new Error('Board restore failed');
    }
    closeUtilityPage();              // leave the tutorial page so the built board is visible
    if (typeof renderAll === 'function') renderAll();
    window.scrollTo(0, 0);
  } catch (e) {
    console.error('Scenario build failed:', e);
    if (typeof _showSBAToast === 'function') _showSBAToast('Could not build this scenario.');
    if (btn) { btn.disabled = false; btn.textContent = 'Build'; }
  }
}

function renderUtilityRoute() {
  const pageId = (window.location.hash || '').replace(/^#/, '').toLowerCase();
  if (!UTILITY_PAGES.has(pageId)) {
    closeUtilityPage(false);
    return;
  }

  const shell = document.getElementById('utility-page-shell');
  if (!shell) return;

  shell.innerHTML = getUtilityPageHtml(pageId);
  shell.hidden = false;
  document.body.classList.add('utility-page-open');
  updateUtilityNavState(pageId);

  if (pageId === 'contact') bindContactForm();
  const heading = shell.querySelector('.utility-page-title');
  if (heading) heading.focus({ preventScroll: true });
}

function closeUtilityPage(clearHash = true) {
  const shell = document.getElementById('utility-page-shell');
  if (shell) {
    shell.hidden = true;
    shell.innerHTML = '';
  }
  document.body.classList.remove('utility-page-open');
  updateUtilityNavState('');

  if (clearHash && window.location.hash) {
    history.pushState('', document.title, window.location.pathname + window.location.search);
  }
}

function updateUtilityNavState(activePageId) {
  document.querySelectorAll('.header-icon-button[href^="#"]').forEach(link => {
    const pageId = link.getAttribute('href').replace('#', '');
    const isActive = pageId === activePageId;
    link.classList.toggle('active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function getUtilityPageHtml(pageId) {
  if (pageId === 'contact') return contactPageHtml();
  if (pageId === 'about') return aboutPageHtml();
  return tutorialPageHtml();
}

function utilityPageFrame(kicker, bodyHtml) {
  return `
    <section class="utility-page">
      <header class="utility-page-header">
        <h2 class="utility-page-title" tabindex="-1">${kicker}</h2>
      </header>
      ${bodyHtml}
    </section>`;
}

function contactPageHtml() {
  const body = `
    <div class="utility-page-grid utility-page-grid-contact">
      <div class="utility-copy">
        <p>I have done my best to account for all the card interactions I can think of, but given the complexity of Magic and the growing number of cards, it is very likely that I have missed some! If you find that a card or interaction that is not working correctly, you can report it here. When you do so, please include the name of the card(s) that were not working and/or what the expected outcome should be.</p>
      </div>
      <form id="contact-form" class="contact-form" action="https://formsubmit.co/mullimancm@gmail.com" method="POST">
        <input type="text" name="_honey" class="contact-hidden-field" tabindex="-1" autocomplete="off" aria-hidden="true">
        <input type="hidden" name="_subject" value="MTG Layer Inspector bug report">
        <input type="hidden" name="_template" value="box">
        <input type="hidden" name="_captcha" value="false">
        <input id="contact-url" type="hidden" name="_url" value="">

        <label class="contact-field">
          <span>Your message</span>
          <textarea id="contact-message" name="message" rows="10" required placeholder="Card names, what happened, and what you expected instead."></textarea>
        </label>

        <label class="contact-field">
          <span>Reply email <em>(optional)</em></span>
          <input id="contact-reply-email" type="email" name="email" autocomplete="email" placeholder="you@example.com">
        </label>

        <div class="contact-actions">
          <button class="btn-accent contact-send-btn" type="submit">Send</button>
        </div>
        <div id="contact-status" class="contact-status" role="status" aria-live="polite"></div>
      </form>
    </div>`;
  return utilityPageFrame('Report a card interaction', body);
}

function aboutPageHtml() {
  const body = `
    <div class="utility-copy utility-copy-narrow">
      <p>This website was created because the layer system, while absolutely brilliant, can also sometimes be confusing, unintuitive, hard to remember, and very difficult to keep track of. Having a visual aid going layer by layer can be helpful for understanding it. It is designed specifically with MtG players in mind to help educate them about layer interactions and dependencies. It can even help you keep track of boardstates as layer interactions grow!</p>
      <p>This is a passion project for me, and I want to keep it free without ads. Please consider donating to help support me as I continue updating and maintaining the website!</p>
      <header class="utility-page-header" style="margin-top:32px">
        <h2 class="utility-page-title">A word of thanks</h2>
      </header>
      <p>This would not be possible if it were not for the excellent dependency tutorial made by Isaac King from Outside the Asylum. His article, Step by Step Dependency, is what taught me how to read layers and helped me work out the logic of the website. He also provided excellent scenarios that I used to test and troubleshoot the website. His other website, RulesGuru, was also very handy for this.</p>
      <p>Thank you as well to Attack on Cardboard for the great layers videos and clarifications. He brings up great examples of tricky rules interactions, and his videos were always well presented and articulated.</p>
      <p>Lastly, a great big thank you to u/Judge_Todd and other members of r/MTGRules for their incredible patience when teaching me some of the more niche rule and layer interactions. It took me a very long time to figure out some interactions, and they helped me through it all.</p>
    </div>`;
  return utilityPageFrame('Why this exists', body);
}

function _tutorialVideoButtons(clips) {
  return clips.map(([label, file]) =>
    `<button class="tutorial-video-btn" type="button" data-src="assets/${encodeURIComponent(file)}" data-label="${label}">${label}</button>`
  ).join('');
}

function _tutorialScenarioItems() {
  return TUTORIAL_SCENARIOS.map((s, i) => `
          <li>
            <div class="tutorial-scenario-head">
              <strong>Scenario ${i + 1}</strong>
              <button class="scenario-build-btn" type="button" data-file="${escapeAttr(s.file)}">Build</button>
            </div>
            ${s.desc}
          </li>`).join('');
}

function tutorialPageHtml() {
  const body = `
    <div class="tutorial-layout">
      <section class="tutorial-section">
        <h3>Build the board</h3>
        <p>Use Card Search to find a card, then press the plus button to add it to the battlefield. Turn on Search Tokens when you need token cards, and use the player tabs above the battlefield to switch boards or add another player.</p>
        <div class="tutorial-videos">${_tutorialVideoButtons([
          ['Build the Board',         'Build the Board.mov'],
          ['Build the Board (Tokens)', 'Build the Board (Tokens).mov'],
          ['Add a Player',            'Add a player.mov'],
          ['Add an Emblem',           'Add an Emblem.mov'],
          ['Add an Eminence Ability', 'Add an Eminence Ability.mov'],
        ])}</div>
      </section>
      <section class="tutorial-section">
        <h3>Configure the cards</h3>
        <p>Cards with choices, targets, counters, copy effects, modal abilities, equipment, Bestow, Mutate, or face options expose small controls in the timestamp list, card tile, or inspector. Set those options so the board matches the game state you want to check.</p>
        <div class="tutorial-videos">${_tutorialVideoButtons([
          ['Configure Bestow',  'Configure bestow.mov'],
          ['Configure Mutate',  'Configure Mutate.mov'],
        ])}</div>
      </section>
      <section class="tutorial-section">
        <h3>Read the layer result</h3>
        <p>Select a card on the battlefield to inspect it. The Layer Inspector shows each relevant CR 613 layer in order, the effects that applied there, and the final characteristics after all continuous effects are evaluated. Dependency notes appear where the rules require effects to apply out of simple timestamp order.</p>
        <div class="tutorial-videos">${_tutorialVideoButtons([
          ['Inspecting a Permanent',  'Inspecting a Permanent.mov'],
        ])}</div>
      </section>
      <section class="tutorial-section">
        <h3>Adjust ordering</h3>
        <p>Drag items in Timestamp Order when effects need a different timestamp. The website will automatically update to reflect any changes in timestamp order.</p>
        <div class="tutorial-videos">${_tutorialVideoButtons([
          ['Reorder Effects',  'Reorder Effects.mov'],
        ])}</div>
      </section>
      <section class="tutorial-section">
        <h3>Track extra zones</h3>
        <p>The left panel also supports the command zone, emblems, graveyard, exile, counters, and general game-state values. Use those when a card's effect depends on something outside the visible battlefield.</p>
        <div class="tutorial-videos">${_tutorialVideoButtons([
          ['Add a Commander', 'Add a commander.mov'],
        ])}</div>
      </section>
      <section class="tutorial-section">
        <h3>Reset or simplify</h3>
        <p>Use Clear All to empty the current battlefield. Hide Abilities reduces battlefield card text when you want a cleaner view while keeping the rules evaluation intact.</p>
        <div class="tutorial-videos">${_tutorialVideoButtons([
          ['Clear All',      'Clear All.mov'],
          ['Hide Abilities', 'Hide Abilities.mov'],
        ])}</div>
      </section>
      <section class="tutorial-section">
        <h3>Keyboard shortcuts</h3>
        <p>These shortcuts work while you are not typing in a field and no dialog is open. Press the question-mark key at any time to bring up this same list.</p>
        <table class="shortcuts-help-table tutorial-shortcuts-table">
          <tr><td><kbd>/</kbd></td><td>Card search</td></tr>
          <tr><td><kbd>c</kbd></td><td>Clear battlefield</td></tr>
          <tr><td><kbd>h</kbd></td><td>Toggle Hide abilities</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Close a dialog or clear search</td></tr>
        </table>
      </section>
      <section class="tutorial-section">
        <h3>Do you know how layers work? Try out these scenarios to test your knowledge!</h3>
        <ol class="tutorial-scenarios">${_tutorialScenarioItems()}</ol>
        <p class="tutorial-scenarios-footer" style="margin-top:1em">Want more scenarios? Check out <a href="https://rulesguru.org" target="_blank" rel="noopener noreferrer">RulesGuru's website</a> for more!</p>
      </section>
    </div>`;
  return utilityPageFrame('How to use the evaluator', body);
}

function ensureVideoModal() {
  if (document.getElementById('tutorial-video-modal')) return;
  const overlay = document.createElement('div');
  overlay.id = 'tutorial-video-modal';
  overlay.className = 'video-modal-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="video-modal-box">
      <div class="video-modal-titlebar">
        <span class="video-modal-title" id="video-modal-title"></span>
        <button class="video-modal-close" type="button" aria-label="Close video">Close</button>
      </div>
      <video class="video-modal-player" id="video-modal-player" controls playsinline></video>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeVideoModal();
  });
  overlay.querySelector('.video-modal-close').addEventListener('click', closeVideoModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) closeVideoModal();
  });
}

function openVideoModal(src, title) {
  ensureVideoModal();
  const overlay = document.getElementById('tutorial-video-modal');
  const player  = document.getElementById('video-modal-player');
  const titleEl = document.getElementById('video-modal-title');
  titleEl.textContent = title || '';
  player.src = src;
  overlay.hidden = false;
  player.play().catch(() => {});
}

function closeVideoModal() {
  const overlay = document.getElementById('tutorial-video-modal');
  if (!overlay) return;
  const player = document.getElementById('video-modal-player');
  player.pause();
  player.src = '';
  overlay.hidden = true;
}

function bindContactForm() {
  const form = document.getElementById('contact-form');
  const message = document.getElementById('contact-message');
  const status = document.getElementById('contact-status');
  const pageUrl = document.getElementById('contact-url');
  if (!form || !message || !status) return;
  if (pageUrl) pageUrl.value = window.location.href;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!message.value.trim()) {
      status.className = 'contact-status error';
      status.textContent = 'Please add a message before sending.';
      message.focus();
      return;
    }

    if (form.elements._honey.value) return;

    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    status.className = 'contact-status';
    status.textContent = 'Sending...';

    const payload = new FormData(form);

    try {
      const response = await fetch('https://formsubmit.co/ajax/mullimancm@gmail.com', {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: payload
      });
      if (!response.ok) throw new Error('Email service rejected the request.');

      form.reset();
      if (pageUrl) pageUrl.value = window.location.href;
      status.className = 'contact-status success';
      status.textContent = 'Sent. Thank you for reporting it!';
    } catch (err) {
      status.className = 'contact-status error';
      status.textContent = 'This browser could not send the message directly. Please try again in a moment.';
    } finally {
      submitButton.disabled = false;
    }
  });
}
