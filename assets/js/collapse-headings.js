/**
 * Collapsible Headings for Blog Posts
 * Click any h2-h6 heading to collapse/expand its content section.
 * Uses level-aware Range extraction to build nested collapsible sections.
 */
(function () {
    'use strict';

    function init() {
        var content = document.querySelector('.post-content');
        if (!content) return;

        // Collect all headings with their levels
        var headingEls = content.querySelectorAll('h2, h3, h4, h5, h6');
        if (headingEls.length === 0) return;

        var headings = [];
        headingEls.forEach(function (h) {
            headings.push({ el: h, level: parseInt(h.tagName.substring(1)) });
        });

        // Process bottom-up (deepest to shallowest) so child sections are
        // already wrapped when parent extracts its content range
        for (var i = headings.length - 1; i >= 0; i--) {
            var h = headings[i].el;
            var level = headings[i].level;

            // Find the next heading of same or higher level
            var endAt = null;
            for (var j = i + 1; j < headings.length; j++) {
                if (headings[j].level <= level) {
                    endAt = headings[j].el;
                    break;
                }
            }

            // Extract content range: from after heading to before next same/higher heading
            var range = document.createRange();
            range.setStartAfter(h);
            if (endAt) {
                range.setEndBefore(endAt);
            } else {
                range.setEndAfter(content.lastChild);
            }

            // Extract the content fragment
            var fragment = range.extractContents();

            // Create collapse body
            var body = document.createElement('div');
            body.className = 'collapse-body';
            body.appendChild(fragment);

            // Create toggle indicator
            var toggle = document.createElement('span');
            toggle.className = 'collapse-toggle';
            toggle.textContent = '▼';
            toggle.setAttribute('aria-hidden', 'true');

            h.insertBefore(toggle, h.firstChild);
            h.classList.add('has-collapse');
            h.title = '点击折叠/展开';

            // Insert body after heading
            h.parentNode.insertBefore(body, h.nextSibling);

            // Wrap heading + body in section div
            var wrapper = document.createElement('div');
            wrapper.className = 'collapse-section';
            h.parentNode.insertBefore(wrapper, h);
            wrapper.appendChild(h);
            wrapper.appendChild(body);

            // Set initial height
            body.style.maxHeight = 'none';
            requestAnimationFrame((function (b) {
                return function () {
                    b.style.transition = 'max-height 0.3s ease';
                    b.style.maxHeight = b.scrollHeight + 'px';
                };
            })(body));
        }

        // Delegate click events for all headings to avoid per-element listeners
        content.addEventListener('click', function (e) {
            var heading = e.target;
            // Walk up to find the heading in case click is on toggle span
            while (heading && heading !== content) {
                if (/^H[2-6]$/.test(heading.tagName) && heading.classList.contains('has-collapse')) {
                    break;
                }
                heading = heading.parentNode;
            }
            if (!heading || heading === content) return;

            if (e.target.tagName === 'A' || e.target.tagName === 'IMG') return;

            var section = heading.parentNode;
            if (!section || !section.classList.contains('collapse-section')) return;

            var bodyEl = section.querySelector('.collapse-body');
            var toggleEl = heading.querySelector('.collapse-toggle');
            if (!bodyEl) return;

            var isCollapsed = bodyEl.style.maxHeight === '0px' || bodyEl.getAttribute('data-collapsed') === 'true';

            if (isCollapsed) {
                bodyEl.style.maxHeight = 'none';
                bodyEl.offsetHeight;
                bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
                bodyEl.setAttribute('data-collapsed', 'false');
                if (toggleEl) toggleEl.textContent = '▼';
            } else {
                bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
                bodyEl.offsetHeight;
                bodyEl.style.maxHeight = '0px';
                bodyEl.setAttribute('data-collapsed', 'true');
                if (toggleEl) toggleEl.textContent = '▶';
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
