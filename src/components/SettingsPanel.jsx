/**
 * SettingsPanel — layout shell for the Settings tab: the "jump to section"
 * search, the desktop sticky rail (see .settings-layout in global.css), and
 * the 13 section components under Settings/sections/. Each section owns its
 * own state and calls whatever hooks (useScheduler/useAuth/etc.) it needs
 * directly, rather than this shell threading ~50 props down — this file is
 * purely navigation plumbing, with zero knowledge of what any section
 * actually configures.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile';
import AccountSection from './Settings/sections/AccountSection';
import IntegrationsSection from './Settings/sections/IntegrationsSection';
import SchedulingSection from './Settings/sections/SchedulingSection';
import RoutinesSection from './Settings/sections/RoutinesSection';
import AppearanceSection from './Settings/sections/AppearanceSection';
import TagsSection from './Settings/sections/TagsSection';
import NotificationsSection from './Settings/sections/NotificationsSection';
import InstallAppSection from './Settings/sections/InstallAppSection';
import HelpSection from './Settings/sections/HelpSection';
import ShortcutsSection from './Settings/sections/ShortcutsSection';
import VersionsSection from './Settings/sections/VersionsSection';
import BackupsSection from './Settings/sections/BackupsSection';
import DangerZoneSection from './Settings/sections/DangerZoneSection';

// One entry per section component below, in the same top-to-bottom order —
// drives the settings search dropdown's suggestions and its scroll target
// (see sectionRefs). Keep this in sync if a section is added/renamed/reordered.
// installApp is a genuine special case: InstallAppSection renders null on
// desktop / already-installed (the rail only shows on desktop — see
// .settings-rail's own breakpoint — so on desktop these two conditions are
// mutually exclusive: the rail can never be visible while InstallAppSection
// renders real content). Left in the rail/search unfiltered, that meant a
// permanently dead "Install app" link/search-result whenever the rail was
// visible at all — clicking it scrolled nowhere with zero feedback. Filtered
// out of the rail and search results via `visibleSections` below (not out of
// this array itself, so the IntersectionObserver/scroll-tracking effects
// further down — which already tolerate a missing ref via `.filter(Boolean)`
// — don't need their own separate list).
const SETTINGS_SECTIONS = [
  { id: 'account', label: 'Account & sync' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'scheduling', label: 'Scheduling rules' },
  { id: 'routines', label: 'Fixed routines' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'tags', label: 'Tags' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'installApp', label: 'Install app' },
  { id: 'help', label: 'Help' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'versions', label: 'Versions' },
  { id: 'backups', label: 'Backups' },
  { id: 'dangerZone', label: 'Danger zone' },
];

/** @param {{ onOpenTour: () => void }} props — replays the app-level guided tour (see App.jsx), which needs to be able to switch tabs as it advances. */
export default function SettingsPanel({ onOpenTour, settingsSectionRequest }) {
  const isMobile = useIsMobile();
  // See SETTINGS_SECTIONS' own comment above for why installApp is excluded
  // here specifically (rail + search), not from SETTINGS_SECTIONS itself.
  const visibleSections = SETTINGS_SECTIONS.filter((s) => s.id !== 'installApp' || isMobile);
  const [sectionQuery, setSectionQuery] = useState('');
  const [isSectionSearchFocused, setIsSectionSearchFocused] = useState(false);
  const sectionSearchRef = useRef(null);
  const sectionRefs = useRef({});
  // Which section the desktop rail highlights. Tracked by observing the
  // section elements rather than by scroll offset maths, so it stays correct
  // regardless of each card's own height (they vary a lot — Integrations is
  // several hundred px, Versions is one row).
  const [currentSection, setCurrentSection] = useState(SETTINGS_SECTIONS[0].id);

  useEffect(() => {
    function handlePointerDown(e) {
      if (sectionSearchRef.current && !sectionSearchRef.current.contains(e.target)) setIsSectionSearchFocused(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  const matchingSections = sectionQuery.trim()
    ? visibleSections.filter((s) => s.label.toLowerCase().includes(sectionQuery.trim().toLowerCase()))
    : [];
  const showSectionDropdown = isSectionSearchFocused && matchingSections.length > 0;

  function goToSection(id) {
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setSectionQuery('');
    setIsSectionSearchFocused(false);
  }

  // Component remounts on every navigation into the Settings tab (see the
  // `{tab === 'settings' && <SettingsPanel ... />}` guard in App.jsx), so this
  // fires fresh each time a caller elsewhere requests a section via
  // requestSettingsSection.
  useEffect(() => {
    if (settingsSectionRequest?.section) goToSection(settingsSectionRequest.section);
  }, [settingsSectionRequest?.requestId]);

  // Highlight whichever section is nearest the top of the viewport in the
  // desktop rail. rootMargin's large negative bottom shrinks the observed
  // band to roughly the top fifth of the viewport, so the "current" section
  // is the one being read rather than whichever merely happens to be visible
  // — without it, a short card near the bottom of a tall viewport can win
  // over the one actually under the reader's eye.
  useEffect(() => {
    const elements = SETTINGS_SECTIONS.map((s) => sectionRefs.current[s.id]).filter(Boolean);
    if (elements.length === 0 || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        const id = SETTINGS_SECTIONS.find((s) => sectionRefs.current[s.id] === visible.target)?.id;
        if (id) setCurrentSection(id);
      },
      { rootMargin: '-64px 0px -80% 0px' }
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  });

  // The band above only ever asks "what's near the TOP of the viewport" —
  // that geometrically can't answer for the trailing section(s) once the
  // page has scrolled as far as it can and there's no more room below them
  // to push their top up into that band (e.g. Danger Zone, the shortest,
  // last card: the observed band sits at ~64-144px from the viewport top,
  // but at max scroll its own top can still be several hundred px down).
  // Rather than trying to out-tune the band for every possible content
  // height, this is the direct fix: once the settings scroll container is
  // at (or within a couple of rounding px of) its own max scroll position,
  // the last section unconditionally wins — matching what a reader would
  // actually call "current" once they've scrolled all the way down.
  useEffect(() => {
    const scrollEl = sectionRefs.current[SETTINGS_SECTIONS[0].id]?.closest('.main-content');
    if (!scrollEl) return undefined;
    const lastId = SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1].id;

    function handleScroll() {
      const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2;
      if (atBottom) setCurrentSection(lastId);
    }
    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll(); // covers landing already-scrolled (e.g. via settingsSectionRequest)
    return () => scrollEl.removeEventListener('scroll', handleScroll);
  });

  return (
    <>
      <div className="settings-search-bar-wrap">
        <div className="settings-search-bar-backdrop" aria-hidden="true" />
        <div className="search-bar settings-search-bar" ref={sectionSearchRef}>
          <div className="search-bar-field">
            <span className="search-bar-icon">
              <Search size={14} />
            </span>
            <input
              type="text"
              className="search-bar-input"
              value={sectionQuery}
              onChange={(e) => setSectionQuery(e.target.value)}
              onFocus={() => setIsSectionSearchFocused(true)}
              placeholder="Search settings…"
              aria-label="Search settings"
            />
          </div>
          {showSectionDropdown && (
            <div className="search-bar-dropdown">
              <div className="search-bar-dropdown-group">
                {matchingSections.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="search-bar-dropdown-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => goToSection(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="settings-layout">
        {/* Desktop-only jump rail (hidden under 1024px — see global.css); the
            sticky search bar above stays the way in on narrower viewports. */}
        <nav className="settings-rail" aria-label="Settings sections">
          {visibleSections.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings-rail-link ${currentSection === s.id ? 'is-current' : ''}`}
              aria-current={currentSection === s.id ? 'true' : undefined}
              onClick={() => goToSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          <AccountSection sectionRef={(el) => (sectionRefs.current.account = el)} />
          <IntegrationsSection sectionRef={(el) => (sectionRefs.current.integrations = el)} />
          <SchedulingSection sectionRef={(el) => (sectionRefs.current.scheduling = el)} />
          <RoutinesSection sectionRef={(el) => (sectionRefs.current.routines = el)} />
          <AppearanceSection sectionRef={(el) => (sectionRefs.current.appearance = el)} />
          <TagsSection sectionRef={(el) => (sectionRefs.current.tags = el)} />
          <NotificationsSection sectionRef={(el) => (sectionRefs.current.notifications = el)} />
          <InstallAppSection sectionRef={(el) => (sectionRefs.current.installApp = el)} />
          <HelpSection sectionRef={(el) => (sectionRefs.current.help = el)} onOpenTour={onOpenTour} />
          <ShortcutsSection sectionRef={(el) => (sectionRefs.current.shortcuts = el)} />
          <VersionsSection sectionRef={(el) => (sectionRefs.current.versions = el)} />
          <BackupsSection sectionRef={(el) => (sectionRefs.current.backups = el)} />
          <DangerZoneSection sectionRef={(el) => (sectionRefs.current.dangerZone = el)} />
        </div>
      </div>
    </>
  );
}
