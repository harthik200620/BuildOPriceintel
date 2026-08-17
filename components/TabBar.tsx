'use client';

import React from 'react';
import type { Tab } from '@/lib/route';
import { IconHome, IconGrid, IconSearch, IconBag, IconPin } from './icons';

/**
 * The five places, on a phone.
 *
 * It is a real nav of real links: every tab has an href, so a middle-click and
 * a long-press open it the way a buyer expects, and the click handler is only
 * there to keep the navigation client-side. `aria-current` names the one that
 * is lit, which is also what draws the rule above it — one source, so the
 * highlight and the announcement can never disagree.
 *
 * It does not render above 768 px: the top bar carries the same five
 * destinations there, and two navs claiming the same set is a duplicate
 * landmark for anyone reading the page with a screen reader.
 */
export default function TabBar({
  active, count, onGo,
}: {
  active: Tab | null;
  /** Lines on the estimate. Renders a badge; 0 renders nothing at all. */
  count: number;
  onGo: (tab: Tab) => void;
}) {
  const items: Array<{ id: Tab; href: string; label: string; Icon: typeof IconHome }> = [
    { id: 'home', href: '/', label: 'Home', Icon: IconHome },
    { id: 'categories', href: '/categories', label: 'Categories', Icon: IconGrid },
    { id: 'search', href: '/search', label: 'Search', Icon: IconSearch },
    { id: 'list', href: '/list', label: 'List', Icon: IconBag },
    // Not "Profile": there are no accounts here, and a tab onto a sign-in that
    // does not exist is the same door-onto-a-wall the welcome screen refuses.
    // What a buyer actually needs to change is where the prices land.
    { id: 'where', href: '/welcome', label: 'Delivery', Icon: IconPin },
  ];

  return (
    <nav className="tabbar md:hidden" aria-label="Sections">
      {items.map(({ id, href, label, Icon }) => (
        <a
          key={id}
          href={href}
          aria-current={active === id ? 'page' : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            onGo(id);
          }}
          className="tab anim"
        >
          <span className="relative">
            <Icon size={21} />
            {id === 'list' && count > 0 && (
              <span className="badge" aria-hidden>{count > 99 ? '99+' : count}</span>
            )}
          </span>
          {label}
          {id === 'list' && count > 0 && <span className="sr-only">, {count} on the estimate</span>}
        </a>
      ))}
    </nav>
  );
}
