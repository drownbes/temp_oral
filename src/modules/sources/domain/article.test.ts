import { describe, expect, it } from 'vitest';
import { listingItemTitle, MAX_LINK_TITLE_CHARS } from './article.ts';

describe('listingItemTitle', () => {
  it('keeps link text that is the headline', () => {
    expect(listingItemTitle('Nix flakes in practice', 'Nix flakes in practice - Tweag')).toBe(
      'Nix flakes in practice',
    );
    expect(listingItemTitle('  Release\n notes ', '')).toBe('Release notes');
  });

  it('takes the headline out of a card that contains it, without the site name', () => {
    const card =
      'This update is for the SteamOS Beta and Preview channels.SteamOS 3.9.4 Beta' +
      'Small Update / Patch Notes15 hours ago';
    expect(listingItemTitle(card, 'Steam Deck - SteamOS 3.9.4 Beta - Steam News')).toBe(
      'SteamOS 3.9.4 Beta',
    );
    expect(
      listingItemTitle('New: Kernel 7.4 is out | 3 min read', 'Kernel 7.4 is out | Blog'),
    ).toBe('Kernel 7.4 is out');
  });

  it('uses the article title when the link has no usable text', () => {
    expect(listingItemTitle('', 'Kernel 7.4 is out')).toBe('Kernel 7.4 is out');
    expect(listingItemTitle('x'.repeat(MAX_LINK_TITLE_CHARS + 1), 'Kernel 7.4 is out')).toBe(
      'Kernel 7.4 is out',
    );
  });

  it('keeps a short link text that does not mention the article title', () => {
    expect(listingItemTitle('Read the announcement', 'Kernel 7.4 is out')).toBe(
      'Read the announcement',
    );
  });
});
