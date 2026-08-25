import { bootProvider, delay } from './provider-common.js';

const spaces = [
  { spaceCode: 'NS-POINT-A', name: 'Point A Liverpool Street', brand: 'Point A', vicinity: '13-15 Folgate Street, London E1 6BX', nightly: 145 },
  { spaceCode: 'NS-CITIZENM', name: 'citizenM Shoreditch', brand: 'citizenM', vicinity: '6 Holywell Lane, London EC2A 3ET', nightly: 202 },
  { spaceCode: 'NS-COURTHOUSE', name: 'Courthouse Hotel Shoreditch', brand: 'Courthouse', vicinity: '335-337 Old Street, London EC1V 9LL', nightly: 218 },
  { spaceCode: 'NS-ONE-HUNDRED', name: 'One Hundred Shoreditch', brand: 'Lore Group', vicinity: '100 Shoreditch High Street, London E1 6JQ', nightly: 244 },
];

const tools = [
  {
    name: 'nestsquare.scan_spaces',
    title: 'Scan overnight spaces',
    description: 'Search available hotel rooms and accommodation near a location for a check-in date, guests, and nightly budget.',
    inputSchema: {
      type: 'object',
      properties: {
        near: { type: 'string', description: 'Destination area or city.' },
        checkIn: { type: 'string', format: 'date' },
        nights: { type: 'integer', minimum: 1 },
        guests: { type: 'integer', minimum: 1 },
        nightlyLimit: { type: 'number' },
      },
      required: ['near', 'checkIn'],
    },
    annotations: { readOnlyHint: true },
    async execute(input, { signal } = {}) {
      await delay(260, signal);
      const filtered = spaces.filter((space) => !input.nightlyLimit || space.nightly <= Number(input.nightlyLimit));
      return { query: input, spaces: filtered };
    },
  },
  {
    name: 'nestsquare.hold_space',
    title: 'Hold an overnight space',
    description: 'Place a reversible temporary hold on one hotel room for the selected date. No payment or final booking is made.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceCode: { type: 'string' },
        checkIn: { type: 'string', format: 'date' },
        nights: { type: 'integer', minimum: 1 },
      },
      required: ['spaceCode', 'checkIn'],
    },
    annotations: { readOnlyHint: false },
    async execute({ spaceCode, checkIn, nights = 1 }, { signal } = {}) {
      await delay(200, signal);
      const option = spaces.find((item) => item.spaceCode === spaceCode);
      if (!option) throw new Error(`Unknown accommodation space: ${spaceCode}`);
      return { holdId: `NS-HOLD-${spaceCode}`, status: 'held', expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), checkIn, nights, nightly: option.nightly };
    },
  },
];

bootProvider({ id: 'nestsquare', label: 'NestSquare', tools, initialMessage: 'Accommodation search and reversible room-hold capabilities are ready.' });
