import assert from 'node:assert/strict';
import { test } from 'vitest';

import { mask, maskRow, WITHHELD } from '../src/mask.ts';

/**
 * Two failures, opposite and equally bad. Letting a number through makes a database of somebody's
 * personal contacts out of a database of flats. Taking too much turns a listing into rubble: an advert
 * is mostly numbers — the rent, the area, the floor — and a greedy pattern eats all of them.
 */

test('a number is taken out however the advert spells it', () => {
  const written = [
    'Liên hệ: 0899680413',
    'LH 090 123 4567 gặp anh Tuấn',
    'Zalo: 0356.789.012',
    'call +84 908 765 432',
    'sđt 0912-345-678',
    'Hotline (084) 987654321',
  ];
  for (const one of written) {
    assert.ok(mask(one).includes(WITHHELD), `не вырезано: ${one}`);
    assert.ok(!/\d{9}/.test(mask(one).replace(/\D/g, '')), `цифры остались: ${one} → ${mask(one)}`);
  }
});

test('what an advert is actually about is left alone', () => {
  const kept = [
    'Giá 12.000.000 đ/tháng, diện tích 45 m²',
    'Cho thuê căn hộ 2 phòng ngủ 2 WC, tầng 12, toà A',
    'Đặt cọc 1 tháng, giá 8.500.000 ₫',
    'Muong Thanh Luxury, 60 Tran Phu',
    '2 PN, 55m2, full nội thất, 7tr/th',
  ];
  for (const one of kept) {
    assert.equal(mask(one), one, `съедено лишнее: ${one} → ${mask(one)}`);
  }
});

test('a price and a phone in one line lose only the phone', () => {
  const said = 'Giá 12.000.000 đ/tháng. Liên hệ 0899680413 để xem nhà.';
  const clean = mask(said);

  assert.ok(clean.includes('12.000.000'), 'цена осталась');
  assert.ok(clean.includes(WITHHELD));
  assert.ok(!clean.includes('0899680413'));
});

test('nothing is invented where there was nothing', () => {
  assert.equal(mask(null), null);
  assert.equal(mask(undefined), null);
  assert.equal(mask(''), '');
});

test('a whole row goes through, and only its texts', () => {
  const clean = maskRow({
    title_vi: 'Cho thuê 2PN, LH 0908765432',
    price: '12000000',
    lat: '10.85',
    body_vi: 'Zalo 0356789012, giá 12.000.000đ',
    project_vi: null,
  });

  assert.ok(clean.title_vi.includes(WITHHELD));
  assert.ok(clean.body_vi.includes(WITHHELD));
  assert.ok(clean.body_vi.includes('12.000.000'), 'цена в описании цела');
  assert.equal(clean.price, '12000000', 'числовые колонки не трогаются');
  assert.equal(clean.lat, '10.85');
  assert.equal(clean.project_vi, null);
});
