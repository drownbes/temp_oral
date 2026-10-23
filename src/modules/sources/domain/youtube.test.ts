import { describe, expect, it } from 'vitest';
import {
  isYouTubeShort,
  isYouTubeUrl,
  videoText,
  youtubeChannelIdOf,
  youtubeVideoId,
} from './youtube.ts';

const CHANNEL = 'UCHnyfMqiRRG1u-2MsSQLbXA';

describe('youtubeChannelIdOf', () => {
  it.each([
    `https://www.youtube.com/channel/${CHANNEL}`,
    `https://youtube.com/channel/${CHANNEL}/videos`,
    `https://m.youtube.com/channel/${CHANNEL}`,
    `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`,
  ])('reads the channel id of %s', (url) => {
    expect(youtubeChannelIdOf(url)).toBe(CHANNEL);
  });

  it.each([
    'https://www.youtube.com/@veritasium',
    'https://www.youtube.com/channel/not-a-channel',
    'https://www.youtube.com/watch?v=NiCgcUTL9_Q',
    `https://example.com/channel/${CHANNEL}`,
  ])('finds none in %s', (url) => {
    expect(youtubeChannelIdOf(url)).toBeUndefined();
  });
});

describe('youtube videos', () => {
  it.each([
    ['https://www.youtube.com/watch?v=NiCgcUTL9_Q', 'NiCgcUTL9_Q'],
    ['https://www.youtube.com/shorts/wxLc-gFORPQ', 'wxLc-gFORPQ'],
    ['https://youtu.be/NiCgcUTL9_Q', 'NiCgcUTL9_Q'],
    ['https://www.youtube.com/watch?v=short', undefined],
    ['https://example.com/watch?v=NiCgcUTL9_Q', undefined],
  ])('video id of %s is %s', (url, id) => {
    expect(youtubeVideoId(url)).toBe(id);
  });

  it('tells Shorts from videos', () => {
    expect(isYouTubeShort('https://www.youtube.com/shorts/wxLc-gFORPQ')).toBe(true);
    expect(isYouTubeShort('https://www.youtube.com/watch?v=NiCgcUTL9_Q')).toBe(false);
    expect(isYouTubeShort('https://example.com/shorts/x')).toBe(false);
  });

  it('knows YouTube hosts', () => {
    expect(isYouTubeUrl('https://www.youtube.com/@veritasium')).toBe(true);
    expect(isYouTubeUrl('https://example.com/@veritasium')).toBe(false);
  });
});

describe('videoText', () => {
  it('puts the transcript first and the description after it', () => {
    expect(videoText('Links and sponsors', ' What is said ')).toBe(
      'What is said\n\nVideo description:\nLinks and sponsors',
    );
  });

  it('is the description alone without a transcript', () => {
    expect(videoText('Links and sponsors', undefined)).toBe('Links and sponsors');
    expect(videoText('Links and sponsors', '  ')).toBe('Links and sponsors');
  });

  it('is the transcript alone without a description', () => {
    expect(videoText('', 'What is said')).toBe('What is said');
  });
});
