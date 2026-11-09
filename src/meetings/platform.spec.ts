import { detectPlatform } from './platform';

describe('detectPlatform', () => {
  it('detecta URLs do Google Meet (código e lookup)', () => {
    expect(detectPlatform('https://meet.google.com/abc-defg-hij')).toBe('MEET');
    expect(
      detectPlatform('https://meet.google.com/abc-defg-hij?authuser=0'),
    ).toBe('MEET');
    expect(detectPlatform('https://meet.google.com/lookup/abcdef')).toBe(
      'MEET',
    );
  });

  it('detecta URLs do Microsoft Teams (meetup-join, /meet/ e teams.live)', () => {
    expect(
      detectPlatform(
        'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=%7b%7d',
      ),
    ).toBe('TEAMS');
    expect(detectPlatform('https://teams.live.com/meet/1234567890')).toBe(
      'TEAMS',
    );
    expect(
      detectPlatform('https://teams.microsoft.com/meet/1234567890?p=abcDEF12'),
    ).toBe('TEAMS');
  });

  it('rejeita links desconhecidos ou forjados', () => {
    expect(detectPlatform('https://zoom.us/j/123456')).toBeNull();
    // prefixo malicioso não deve casar (âncora ^https)
    expect(
      detectPlatform('https://evil.com/meet.google.com/abc-defg-hij'),
    ).toBeNull();
    expect(detectPlatform('http://meet.google.com/abc-defg-hij')).toBeNull(); // exige https
    expect(detectPlatform('')).toBeNull();
    expect(detectPlatform('não é uma url')).toBeNull();
  });
});
