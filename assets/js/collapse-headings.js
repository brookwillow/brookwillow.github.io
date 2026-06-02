/**
 * Collapsible Headings for Blog Posts
 * Click any h2-h6 heading to collapse/expand its content section.
 * Initial state: all expanded. Smooth animation on toggle.
 */
(function () {
    'use strict';

    function init() {
        var content = document.querySelector('.post-content');
        if (!content) return;

        var headings = content.querySelectorAll('h2, h3, h4, h5, h6');
        if (headings.length === 0) return;

        // Group: each heading owns the content up to the next heading of same or higher level
        var sections = [];
        var current = null;

        for (var i = 0; i < content.children.length; i++) {
            var child = content.children[i];
            var tag = child.tagName || '';
            var isHeading = /^H[2-6]$/.test(tag);

            if (isHeading) {
                current = {
                    heading: child,
                    level: parseInt(tag.substring(1)),
                    bodyNodes: []
                };
                sections.push(current);
            } else if (current) {
                current.bodyNodes.push(child);
            }
        }

        if (sections.length === 0) return;

        // Process each section
        sections.forEach(function (sec) {
            var h = sec.heading;
            var bodyNodes = sec.bodyNodes;

            // Skip empty sections (no body content)
            if (bodyNodes.length === 0) {
                h.classList.add('collapse-empty');
                return;
            }

            // Create collapse body container
            var body = document.createElement('div');
            body.className = 'collapse-body';

            // Move body nodes into the container
            bodyNodes.forEach(function (node) {
                body.appendChild(node);
            });

            // Create toggle indicator
            var toggle = document.createElement('span');
            toggle.className = 'collapse-toggle';
            toggle.textContent = '▼';
            toggle.setAttribute('aria-hidden', 'true');

            // Insert toggle at start of heading (before any other text)
            h.insertBefore(toggle, h.firstChild);

            // Make heading clickable
            h.classList.add('has-collapse');
            h.title = '点击折叠/展开';

            // Insert body AFTER the heading in the DOM
            h.parentNode.insertBefore(body, h.nextSibling);

            // Wrap heading + body in a section div for clean grouping
            var wrapper = document.createElement('div');
            wrapper.className = 'collapse-section';
            h.parentNode.insertBefore(wrapper, h);
            wrapper.appendChild(h);
            wrapper.appendChild(body);

            // Measure and set initial height
            requestAnimationFrame(function () {
                body.style.maxHeight = body.scrollHeight + 'px';
            });

            // Toggle on heading click
            h.addEventListener('click', function (e) {
                if (e.target.tagName === 'A' || e.target.tagName === 'IMG') return;

                var bodyEl = this.parentNode.querySelector('.collapse-body');
                var toggleEl = this.querySelector('.collapse-toggle');
                if (!bodyEl) return;

                var isCollapsed = bodyEl.style.maxHeight === '0px' || bodyEl.getAttribute('data-collapsed') === 'true';

                if (isCollapsed) {
                    // Expand
                    bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
                    bodyEl.setAttribute('data-collapsed', 'false');
                    if (toggleEl) toggleEl.textContent = '▼';
                    toggleEl && (toggleEl.style.transform = 'rotate(0deg)');
                } else {
                    // Collapse
                    bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
                    // Force reflow then animate to 0
                    bodyEl.offsetHeight;
                    bodyEl.style.maxHeight = '0px';
                    bodyEl.setAttribute('data-collapsed', 'true');
                    if (toggleEl) toggleEl.textContent = '▶';
                    toggleEl && (toggleEl.style.transform = 'rotate(-90deg)');
                }
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
