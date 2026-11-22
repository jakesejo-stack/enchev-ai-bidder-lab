// DEMO lots: every value here is sample data for the simulated auction, never a real listing.
// The retail value is the value DECLARED on the lot (as an auction listing would show it), clearly
// marked as sample data — it is not an estimate made by this app.
// The Porsche lot is used automatically when public/models/porsche-911-gt3.glb is present at build
// time (scripts/build.mjs defines __PORSCHE_GLB__); otherwise the original E&A concept model is used.
import type { LotInfo } from '../domain/types.js';
import { euros } from '../domain/money.js';

const SAMPLE = 'Обявена в лота · примерни ДЕМО данни, не е оценка';

export const CONCEPT_LOT: LotInfo = {
  lotId: 'DEMO-0001',
  title: 'E&A концептуално купе',
  subtitle: 'Демонстрационен 3D модел — не е реален автомобил',
  specs: [
    { label: 'Година', value: '2024' },
    { label: 'Двигател', value: '3.0 L' },
    { label: 'Мощност', value: '380 к.с.' },
    { label: 'Пробег', value: '12 400 км' },
  ],
  details: [
    { label: 'Марка', value: 'E&A (демо концепция)' },
    { label: 'Модел', value: 'Concept Coupé' },
    { label: 'Година', value: '2024' },
    { label: 'Каросерия', value: 'Купе, 2 врати, 2+2 места' },
    { label: 'Двигател', value: '3.0 L V6 битурбо, бензин' },
    { label: 'Мощност', value: '380 к.с. (280 kW)' },
    { label: 'Въртящ момент', value: '520 Nm' },
    { label: 'Скоростна кутия', value: '8-степенна автоматична' },
    { label: 'Задвижване', value: 'Задно' },
    { label: '0–100 км/ч', value: '4,6 с' },
    { label: 'Пробег', value: '12 400 км' },
    { label: 'Цвят', value: 'Червен металик / черен покрив' },
    { label: 'Състояние', value: 'Без щети' },
    { label: 'Ключове', value: '2 бр.' },
    { label: 'Документи', value: 'Регистрация' },
    { label: 'VIN', value: 'EADEMO00000000001' },
    { label: 'Местоположение', value: 'София, BG' },
  ],
  retailValue: euros(96_000),
  retailSource: SAMPLE,
  currency: 'EUR',
  startPrice: 0,
  demo: true,
  modelUrl: '/models/ea-demo-concept-coupe.glb',
};

export const PORSCHE_LOT: LotInfo = {
  lotId: 'DEMO-0911',
  title: 'Porsche 911 GT3 (992)',
  subtitle: 'ДЕМО лот — примерни данни, не е реална обява',
  specs: [
    { label: 'Година', value: '2022' },
    { label: 'Двигател', value: '4.0 L' },
    { label: 'Мощност', value: '510 к.с.' },
    { label: 'Пробег', value: '8 900 км' },
  ],
  details: [
    { label: 'Марка', value: 'Porsche' },
    { label: 'Модел', value: '911 GT3 (992)' },
    { label: 'Година', value: '2022' },
    { label: 'Каросерия', value: 'Купе, 2 врати' },
    { label: 'Двигател', value: '4.0 L 6-цилиндров боксер, атмосферен, бензин' },
    { label: 'Мощност', value: '510 к.с. (375 kW)' },
    { label: 'Въртящ момент', value: '470 Nm' },
    { label: 'Скоростна кутия', value: '7-степенна PDK' },
    { label: 'Задвижване', value: 'Задно' },
    { label: '0–100 км/ч', value: '3,4 с' },
    { label: 'Максимална скорост', value: '318 км/ч' },
    { label: 'Пробег', value: '8 900 км' },
    { label: 'Цвят', value: 'Сребрист металик' },
    { label: 'Състояние', value: 'Без щети' },
    { label: 'Ключове', value: '2 бр.' },
    { label: 'Документи', value: 'Регистрация, сервизна книжка' },
    { label: 'VIN', value: 'WP0ZZZ99ZNSDEMO01' },
    { label: 'Местоположение', value: 'София, BG' },
  ],
  retailValue: euros(215_000),
  retailSource: SAMPLE,
  currency: 'EUR',
  startPrice: 0,
  demo: true,
  modelUrl: '/models/porsche-911-gt3.glb',
};

declare const __PORSCHE_GLB__: boolean | undefined;
/** True when the build found public/models/porsche-911-gt3.glb. */
export const HAS_PORSCHE_GLB = typeof __PORSCHE_GLB__ !== 'undefined' && __PORSCHE_GLB__ === true;
export const DEMO_LOT: LotInfo = HAS_PORSCHE_GLB ? PORSCHE_LOT : CONCEPT_LOT;
