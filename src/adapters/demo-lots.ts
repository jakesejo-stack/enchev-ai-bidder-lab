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

// Similar DEMO lots (sports coupés) for "keep the money for another car". Sample data only:
// not real listings; the estimated retail value is the value stated on each sample lot.
const coupe = (lotId: string, title: string, year: string, engine: string, hp: string, km: string, color: string, vin: string, retailEur: number): LotInfo => ({
  lotId, title, subtitle: 'ДЕМО лот — примерни данни, не е реална обява',
  specs: [{ label: 'Година', value: year }, { label: 'Двигател', value: engine }, { label: 'Мощност', value: hp }, { label: 'Пробег', value: km }],
  details: [
    { label: 'Модел', value: title }, { label: 'Година', value: year }, { label: 'Каросерия', value: 'Купе' },
    { label: 'Двигател', value: engine }, { label: 'Мощност', value: hp }, { label: 'Пробег', value: km },
    { label: 'Цвят', value: color }, { label: 'Състояние', value: 'Без щети' }, { label: 'VIN', value: vin }, { label: 'Местоположение', value: 'София, BG' },
  ],
  retailValue: euros(retailEur), retailSource: SAMPLE, currency: 'EUR', startPrice: 0, demo: true,
});

export const SIMILAR_LOTS: LotInfo[] = [
  coupe('DEMO-0102', 'BMW M4 Competition (G82)', '2022', '3.0 L', '510 к.с.', '28 600 км', 'Сив металик', 'WBS43AZ00NCDEM002', 82_000),
  coupe('DEMO-0103', 'Audi RS 5 Coupé', '2021', '2.9 L', '450 к.с.', '41 200 км', 'Черен', 'WUAZZZF5XMADEM003', 64_000),
  coupe('DEMO-0104', 'Mercedes-AMG C 63 S Coupé', '2020', '4.0 L', '510 к.с.', '52 800 км', 'Бял', 'WDD2053871FDEM004', 58_500),
  coupe('DEMO-0105', 'Lexus RC F', '2021', '5.0 L', '464 к.с.', '33 000 км', 'Червен', 'JTHHP5BC5MADEM005', 61_000),
  coupe('DEMO-0106', 'Porsche 718 Cayman GTS 4.0', '2022', '4.0 L', '400 к.с.', '15 400 км', 'Син', 'WP0ZZZ98ZNSDEM006', 99_000),
];
