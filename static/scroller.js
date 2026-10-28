(() => {
    "use strict";

    const STORAGE_KEY = "redlib-scroller-prefs";
    const REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DEFAULTS = {
        columns: 3,
        titles: true,
        comments: true,
        body: true,
        text: true,
        autoplay: false,
    };

    const masonryRoot = document.querySelector('[data-view="masonry"]');
    const masonryFeed = document.querySelector("[data-masonry-feed]");
    const scrollerPage = document.querySelector('[data-view="scroll"]');
    const scrollFeed = document.querySelector("#scroller-feed");
    const overlay = document.querySelector("[data-scroller-overlay]");
    const overlayFeed = document.querySelector("#scroller-overlay-feed");
    const overlayClose = document.querySelector("[data-scroller-close]");

    if (!masonryRoot && !scrollerPage) {
        return;
    }

    DEFAULTS.autoplay = (masonryRoot || scrollerPage)?.dataset.autoplayDefault === "on";
    let prefs = readPrefs();
    let overlayOpen = false;
    let lastOpenedCard = null;
    let nextAfter = (masonryRoot || scrollerPage).dataset.nextAfter || "";
    let loading = false;
    let emptyPages = 0;
    let layoutFrame = null;
    let overlayTailObserver = null;
    let savedScrollTop = 0;

    const seenMasonryIds = new Set();
    const seenScrollIds = new Set();
    const videoObservers = new WeakMap();
    const layoutObserver = new ResizeObserver(() => scheduleLayout());

    function readPrefs() {
        try {
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
            return { ...DEFAULTS, ...stored };
        } catch {
            return { ...DEFAULTS };
        }
    }

    function savePrefs() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
        } catch {
            // Storage can be unavailable in private mode; the current session
            // still works with the in-memory preferences.
        }
    }

    function applyPrefs(feed) {
        if (!feed) {
            return;
        }

        feed.classList.toggle("cols-2", Number(prefs.columns) === 2);
        feed.classList.toggle("hide-titles", !prefs.titles);
        feed.classList.toggle("hide-comments", !prefs.comments);
        feed.classList.toggle("hide-body", !prefs.body);
        feed.classList.toggle("hide-text", !prefs.text);
    }

    function syncSettingsInputs() {
        document.querySelectorAll("[data-scroller-pref]").forEach(input => {
            const key = input.dataset.scrollerPref;
            if (!(key in prefs)) {
                return;
            }

            if (input.type === "checkbox") {
                input.checked = Boolean(prefs[key]);
            } else {
                input.value = String(prefs[key]);
            }
        });
    }

    function bindSettings() {
        document.addEventListener("change", event => {
            const input = event.target.closest("[data-scroller-pref]");
            if (!input) {
                return;
            }

            const key = input.dataset.scrollerPref;
            prefs[key] = input.type === "checkbox" ? input.checked : Number(input.value);
            savePrefs();
            syncSettingsInputs();
            applyPrefs(masonryFeed);
            applyPrefs(scrollFeed);
            applyPrefs(overlayFeed);
            if (key === "text" && overlayOpen) {
                syncOverlaySlides();
            }
            if (key === "autoplay" && !prefs.autoplay) {
                document.querySelectorAll(".scroller-slide video").forEach(video => video.pause());
            }
            scheduleLayout();
            updateCounter();
        });
    }

    function visibleCards() {
        if (!masonryFeed) {
            return [];
        }

        const hideText = masonryFeed.classList.contains("hide-text");
        return Array.from(masonryFeed.querySelectorAll(":scope > .scroller-card")).filter(card => !hideText || card.dataset.postType !== "self");
    }

    function scheduleLayout() {
        if (!masonryFeed || layoutFrame) {
            return;
        }

        layoutFrame = requestAnimationFrame(() => {
            layoutFrame = null;
            layoutMasonry();
        });
    }

    function layoutMasonry() {
        if (!masonryFeed) {
            return;
        }

        const cards = visibleCards();
        if (cards.length === 0) {
            return;
        }

        masonryFeed.classList.add("masonry-grid");
        const gap = Number.parseFloat(getComputedStyle(masonryFeed).rowGap) || 12;

        const heights = cards.map(card => {
            card.style.removeProperty("--card-span");
            return card.getBoundingClientRect().height;
        });

        cards.forEach((card, index) => {
            const span = Math.max(1, Math.ceil((heights[index] + gap) / (1 + gap)));
            card.style.setProperty("--card-span", String(span));
        });
    }

    function observeCard(card) {
        layoutObserver.observe(card);
        const image = card.querySelector("img");
        if (image && !image.complete) {
            image.addEventListener("load", scheduleLayout, { once: true });
        }
    }

    function observeMasonryCards() {
        if (!masonryFeed) {
            return;
        }

        masonryFeed.querySelectorAll(":scope > .scroller-card").forEach(card => {
            if (card.dataset.masonryObserved === "true") {
                return;
            }
            card.dataset.masonryObserved = "true";
            if (card.dataset.postId) {
                seenMasonryIds.add(card.dataset.postId);
            }
            observeCard(card);
        });
    }

    function initMasonry() {
        if (!masonryFeed || !masonryRoot) {
            return;
        }

        applyPrefs(masonryFeed);
        observeMasonryCards();
        requestAnimationFrame(() => {
            layoutMasonry();
            if (nextAfter) {
                observeMasonrySentinel();
            } else {
                const sentinel = masonryRoot.querySelector("[data-feed-sentinel]");
                if (sentinel) {
                    sentinel.dataset.done = "true";
                }
            }
        });

        window.addEventListener("resize", scheduleLayout, { passive: true });

        masonryFeed.addEventListener("click", event => {
            const card = event.target.closest(".scroller-card");
            if (!card) {
                return;
            }

            if (handleReveal(event, card)) {
                return;
            }

            const trigger = event.target.closest("[data-open-scroller]");
            if (!trigger) {
                return;
            }

            const anchor = event.target.closest("a");
            if (anchor && anchor !== trigger) {
                return;
            }

            event.preventDefault();
            openOverlay(card.dataset.postId, card);
        });

        masonryFeed.addEventListener("keydown", event => {
            if (event.key !== "Enter" && event.key !== " ") {
                return;
            }

            if (event.target.closest("a, button")) {
                return;
            }

            const trigger = event.target.closest("[data-open-scroller]");
            if (!trigger) {
                return;
            }

            event.preventDefault();
            const card = trigger.closest(".scroller-card");
            if (card) {
                openOverlay(card.dataset.postId, card);
            }
        });
    }

    function observeMasonrySentinel() {
        if (!masonryRoot || !nextAfter) {
            return;
        }

        const sentinel = masonryRoot.querySelector("[data-feed-sentinel]");
        if (!sentinel) {
            return;
        }

        const observer = new IntersectionObserver(
            entries => {
                if (entries.some(entry => entry.isIntersecting)) {
                    loadMore("masonry");
                }
            },
            { rootMargin: "800px 0px" }
        );

        observer.observe(sentinel);
        sentinel.addEventListener("click", () => {
            if (sentinel.dataset.done !== "true") {
                emptyPages = 0;
                loadMore("masonry");
            }
        });
    }

    function buildFragmentUrl(view) {
        const url = new URL(window.location.href);
        url.searchParams.set("view", view);
        url.searchParams.set("fragment", "1");
        url.searchParams.set("after", nextAfter);
        url.hash = "";
        return url;
    }

    async function loadMore(view) {
        if (loading || !nextAfter) {
            return;
        }

        loading = true;
        setLoadingState(true);

        try {
            const response = await fetch(buildFragmentUrl(view), {
                headers: { "X-Requested-With": "scroller" },
            });

            if (!response.ok) {
                throw new Error(`Request failed with ${response.status}`);
            }

            const html = await response.text();
            const next = response.headers.get("X-Next-After") || "";
            const template = document.createElement("template");
            template.innerHTML = html;

            let added = 0;
            if (view === "masonry") {
                added = appendMasonryItems(template.content);
                scheduleLayout();
                if (overlayOpen) {
                    syncOverlaySlides();
                }
            } else {
                added = appendScrollItems(template.content);
                initSlides(scrollFeed);
                updateCounter();
            }

            nextAfter = next;
            setLoadingState(false);

            if (added > 0) {
                emptyPages = 0;
            }

            if (!next) {
                markFeedDone();
            } else if (added === 0) {
                // A page can be empty when every post is hidden (for example,
                // NSFW posts with the setting disabled). Walk a few pages
                // automatically, then stop to avoid hammering the instance.
                handleEmptyPage(view);
            }
        } catch (error) {
            console.error("Redlib scroller: could not load the next page", error);
            setLoadingState(false, true);
        } finally {
            loading = false;
        }
    }

    function handleEmptyPage(view) {
        emptyPages += 1;
        if (emptyPages < 3) {
            setTimeout(() => loadMore(view), 150);
        } else {
            setLoadingState(false, true);
        }
    }

    function appendMasonryItems(fragment) {
        if (!masonryFeed) {
            return 0;
        }

        let added = 0;
        fragment.querySelectorAll(".scroller-card").forEach(card => {
            const id = card.dataset.postId;
            if (id && seenMasonryIds.has(id)) {
                return;
            }

            if (id) {
                seenMasonryIds.add(id);
            }

            masonryFeed.appendChild(card);
            observeCard(card);
            added += 1;
        });

        return added;
    }

    function appendScrollItems(fragment) {
        if (!scrollFeed) {
            return 0;
        }

        let added = 0;
        fragment.querySelectorAll(".scroller-slide").forEach(slide => {
            const id = slide.dataset.postId;
            if (id && seenScrollIds.has(id)) {
                return;
            }

            if (id) {
                seenScrollIds.add(id);
            }

            scrollFeed.insertBefore(slide, scrollFeed.querySelector("[data-feed-sentinel]"));
            added += 1;
        });

        return added;
    }

    function setLoadingState(active, failed = false) {
        const sentinel = masonryRoot?.querySelector("[data-feed-sentinel]");
        if (sentinel) {
            sentinel.dataset.done = "false";
            sentinel.textContent = failed ? "Could not load more posts. Click to retry." : active ? "Loading more…" : "";
        }

        const loader = overlayOpen ? overlay?.querySelector("[data-scroller-loader]") : scrollerPage?.querySelector("[data-scroller-loader]");
        if (loader) {
            loader.hidden = !active && !failed;
            loader.textContent = failed ? "Could not load more posts. Click to retry." : "Loading…";
        }
    }

    function markFeedDone() {
        const sentinel = masonryRoot?.querySelector("[data-feed-sentinel]");
        if (sentinel) {
            sentinel.dataset.done = "true";
            sentinel.textContent = "";
        }

        const pageSentinel = scrollerPage?.querySelector("[data-feed-sentinel]");
        if (pageSentinel) {
            pageSentinel.dataset.done = "true";
        }
    }

    function handleReveal(event, container) {
        const button = event.target.closest("[data-scroller-reveal]");
        if (!button) {
            return false;
        }

        event.preventDefault();
        event.stopPropagation();
        container.classList.remove("is-blurred");
        button.remove();
        return true;
    }

    function syncOverlaySlides() {
        if (!overlayFeed || !masonryFeed) {
            return;
        }

        const existing = new Set(Array.from(overlayFeed.querySelectorAll(".scroller-slide")).map(slide => slide.dataset.postId));
        masonryFeed.querySelectorAll(":scope > .scroller-card").forEach(card => {
            const id = card.dataset.postId;
            if (!id || existing.has(id)) {
                return;
            }

            if (card.dataset.postType === "self" && !prefs.text) {
                return;
            }

            const template = card.querySelector("template.scroller-slide-template");
            if (!template) {
                return;
            }

            overlayFeed.appendChild(template.content.cloneNode(true));
            existing.add(id);
        });

        applyPrefs(overlayFeed);
        initSlides(overlayFeed);
        observeOverlayTail();
        updateCounter();
    }

    function openOverlay(postId, card) {
        if (!overlay || !overlayFeed || !masonryFeed) {
            return;
        }

        lastOpenedCard = card?.querySelector("[data-open-scroller]") || card || null;
        savedScrollTop = window.scrollY;
        overlayOpen = true;
        overlay.hidden = false;
        document.body.classList.add("scroller-overlay-open");

        overlayFeed.replaceChildren();
        syncOverlaySlides();

        const slide = overlayFeed.querySelector(`[data-post-id="${cssEscape(postId)}"]`);
        if (slide) {
            requestAnimationFrame(() => slide.scrollIntoView({ block: "start" }));
        }

        history.replaceState(null, "", `#post-${postId}`);
        overlayClose?.focus({ preventScroll: true });
        updateCounter();
    }

    function closeOverlay() {
        if (!overlay || !overlayOpen) {
            return;
        }

        overlay.hidden = true;
        overlayFeed?.replaceChildren();
        overlayTailObserver?.disconnect();
        overlayTailObserver = null;
        overlayOpen = false;
        document.body.classList.remove("scroller-overlay-open");
        history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        window.scrollTo(0, savedScrollTop);
        lastOpenedCard?.focus({ preventScroll: true });
    }

    function observeOverlayTail() {
        if (!overlayOpen || !overlayFeed) {
            return;
        }

        overlayTailObserver?.disconnect();
        const slides = visibleSlides(overlayFeed);
        if (slides.length === 0) {
            return;
        }

        overlayTailObserver = new IntersectionObserver(
            entries => {
                if (entries.some(entry => entry.isIntersecting)) {
                    loadMore("masonry");
                }
            },
            { root: overlayFeed, rootMargin: "1200px 0px" }
        );

        overlayTailObserver.observe(slides[slides.length - 1]);
    }

    function initScrollPage() {
        if (!scrollerPage || !scrollFeed) {
            return;
        }

        applyPrefs(scrollFeed);
        scrollFeed.querySelectorAll(".scroller-slide").forEach(slide => {
            if (slide.dataset.postId) {
                seenScrollIds.add(slide.dataset.postId);
            }
        });
        initSlides(scrollFeed);
        observeScrollSentinel();
        updateCounter();
    }

    function observeScrollSentinel() {
        if (!scrollFeed) {
            return;
        }

        const sentinel = scrollFeed.querySelector("[data-feed-sentinel]");
        if (!sentinel) {
            return;
        }

        const observer = new IntersectionObserver(
            entries => {
                if (entries.some(entry => entry.isIntersecting)) {
                    loadMore("scroll");
                }
            },
            { root: scrollFeed, rootMargin: "1200px 0px" }
        );

        observer.observe(sentinel);
        sentinel.addEventListener("click", () => {
            emptyPages = 0;
            loadMore("scroll");
        });
    }

    function initSlides(feed) {
        if (!feed) {
            return;
        }

        feed.querySelectorAll(".scroller-slide").forEach(slide => {
            if (slide.dataset.slideInitialized === "true") {
                return;
            }
            slide.dataset.slideInitialized = "true";

            const gallery = slide.querySelector("[data-slide-gallery]");
            if (gallery) {
                const counter = slide.querySelector("[data-gallery-counter]");
                const update = () => {
                    if (!counter) {
                        return;
                    }
                    const index = Math.round(gallery.scrollLeft / Math.max(1, gallery.clientWidth)) + 1;
                    counter.textContent = `${index}/${slide.querySelectorAll(".slide-gallery-item").length}`;
                };
                gallery.addEventListener("scroll", () => requestAnimationFrame(update), { passive: true });
                update();
            }
        });

        observeVideos(feed);
    }

    function visibleSlides(feed) {
        const hideText = feed.classList.contains("hide-text");
        return Array.from(feed.querySelectorAll(".scroller-slide")).filter(slide => !hideText || slide.dataset.postType !== "self");
    }

    function updateCounter() {
        const feed = overlayOpen ? overlayFeed : scrollFeed;
        if (!feed) {
            return;
        }

        const slides = visibleSlides(feed);
        if (slides.length === 0) {
            return;
        }

        const index = Math.max(
            0,
            slides.findIndex(slide => slide.offsetTop + slide.offsetHeight > feed.scrollTop + 10)
        );

        const counter = overlayOpen ? overlay?.querySelector("[data-scroller-counter]") : scrollerPage?.querySelector("[data-scroller-counter]");
        if (counter) {
            counter.textContent = `${index + 1} / ${slides.length}`;
        }
    }

    function activeFeed() {
        return overlayOpen ? overlayFeed : scrollFeed;
    }

    function currentSlideIndex(feed) {
        const slides = visibleSlides(feed);
        if (slides.length === 0) {
            return -1;
        }

        return Math.max(
            0,
            slides.findIndex(slide => slide.offsetTop + slide.offsetHeight > feed.scrollTop + 10)
        );
    }

    function activeSlide() {
        const feed = activeFeed();
        if (!feed) {
            return null;
        }

        const slides = visibleSlides(feed);
        const index = currentSlideIndex(feed);
        return slides[index] || null;
    }

    function moveSlide(delta) {
        const feed = activeFeed();
        if (!feed) {
            return;
        }

        const slides = visibleSlides(feed);
        const index = currentSlideIndex(feed);
        if (index < 0) {
            return;
        }

        const next = slides[index + delta];
        if (next) {
            next.scrollIntoView({ behavior: REDUCE_MOTION ? "auto" : "smooth", block: "start" });
        }
    }

    function bindScrollerEvents() {
        document.querySelectorAll("[data-scroller-loader]").forEach(loader => {
            loader.addEventListener("click", () => {
                emptyPages = 0;
                loadMore(overlayOpen ? "masonry" : "scroll");
            });
        });

        [scrollFeed, overlayFeed].forEach(feed => {
            if (!feed) {
                return;
            }

            feed.addEventListener(
                "scroll",
                () => {
                    requestAnimationFrame(updateCounter);
                },
                { passive: true }
            );
        });

        document.addEventListener("click", event => {
            if (event.target.closest("[data-scroller-close]")) {
                closeOverlay();
            }
        });

        document.addEventListener("keydown", event => {
            const feed = activeFeed();
            if (!feed) {
                return;
            }

            if (event.key === "Escape" && overlayOpen) {
                event.preventDefault();
                closeOverlay();
                return;
            }

            const target = event.target;
            if (target instanceof HTMLElement && (target.matches("input, select, textarea") || target.closest("video, .slide-text"))) {
                return;
            }

            if (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "j") {
                event.preventDefault();
                moveSlide(1);
            } else if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "k") {
                event.preventDefault();
                moveSlide(-1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                const gallery = activeSlide()?.querySelector("[data-slide-gallery]");
                if (gallery) {
                    event.preventDefault();
                    gallery.scrollBy({ left: gallery.clientWidth * (event.key === "ArrowRight" ? 1 : -1), behavior: REDUCE_MOTION ? "auto" : "smooth" });
                }
            }
        });
    }

    function bindSlideEvents(feed) {
        if (!feed) {
            return;
        }

        let pointerStart = null;
        feed.addEventListener("pointerdown", event => {
            pointerStart = { x: event.clientX, y: event.clientY };
        });
        feed.addEventListener("pointercancel", () => {
            pointerStart = null;
        });
        feed.addEventListener("pointerup", () => {
            setTimeout(() => {
                pointerStart = null;
            }, 0);
        });
        feed.addEventListener(
            "scroll",
            () => {
                pointerStart = null;
            },
            { passive: true }
        );

        feed.addEventListener("click", event => {
            const start = pointerStart;
            pointerStart = null;

            const slide = event.target.closest(".scroller-slide");
            if (!slide) {
                return;
            }

            if (handleReveal(event, slide)) {
                return;
            }

            if (event.target.closest("a, button, video")) {
                return;
            }

            const gallery = event.target.closest(".slide-gallery");
            const moved = start && (Math.abs(event.clientX - start.x) > 10 || Math.abs(event.clientY - start.y) > 10);

            if (gallery) {
                if (!moved) {
                    slide.classList.toggle("info-hidden");
                }
                return;
            }

            if (slide.classList.contains("slide-self")) {
                return;
            }

            slide.classList.toggle("info-hidden");
        });
    }

    function observeVideos(feed) {
        if (!feed) {
            return;
        }

        let observer = videoObservers.get(feed);
        if (!observer) {
            observer = new IntersectionObserver(
                entries => {
                    entries.forEach(entry => {
                        const video = entry.target.querySelector("video");
                        if (!video) {
                            return;
                        }

                        if (entry.isIntersecting && prefs.autoplay) {
                            video.muted = true;
                            video.play().catch(() => {});
                        } else {
                            video.pause();
                        }
                    });
                },
                { root: feed, threshold: 0.6 }
            );
            videoObservers.set(feed, observer);
        }

        feed.querySelectorAll(".scroller-slide").forEach(slide => {
            if (slide.dataset.videoObserved === "true") {
                return;
            }
            slide.dataset.videoObserved = "true";
            observer.observe(slide);
        });
    }

    function cssEscape(value) {
        if (window.CSS && typeof window.CSS.escape === "function") {
            return window.CSS.escape(value);
        }
        return String(value).replace(/["\\]/g, "\\$&");
    }

    function initDeepLink() {
        if (!masonryFeed || !masonryRoot || !window.location.hash.startsWith("#post-")) {
            return;
        }

        const id = window.location.hash.slice(6);
        const card = masonryFeed.querySelector(`[data-post-id="${cssEscape(id)}"]`);
        if (card && (prefs.text || card.dataset.postType !== "self")) {
            requestAnimationFrame(() => openOverlay(id, card));
        }
    }

    bindSettings();
    initMasonry();
    initScrollPage();
    bindScrollerEvents();
    bindSlideEvents(scrollFeed);
    bindSlideEvents(overlayFeed);
    syncSettingsInputs();
    initDeepLink();
})();
