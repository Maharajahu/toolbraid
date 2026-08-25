import { bootProvider, delay } from './provider-common.js';

const journeys = [
  { quoteId: 'VR-0745', operator: 'West Midlands Railway', from: 'Coventry', to: 'London Euston', leaves: '07:45', arrivalTime: '09:03', fare: 39.90 },
  { quoteId: 'VR-0631', operator: 'Avanti West Coast', from: 'Coventry', to: 'London Euston', leaves: '06:31', arrivalTime: '07:34', fare: 52.40 },
  { quoteId: 'VR-0815', operator: 'West Midlands Railway', from: 'Coventry', to: 'London Euston', leaves: '08:15', arrivalTime: '09:35', fare: 44.70 },
];

const tools = [
  {
    name: 'vectorrail.seek_passages',
    title: 'Seek rail passages',
    description: 'Find available rail journeys, fares, departure times, and arrival times between two places on a requested day.',
    inputSchema: {
      type: 'object',
      properties: {
        leaving: { type: 'string', description: 'Origin station or city.' },
        arriving: { type: 'string', description: 'Destination station or city.' },
        day: { type: 'string', format: 'date' },
        travellers: { type: 'integer', minimum: 1 },
      },
      required: ['leaving', 'arriving', 'day'],
    },
    annotations: { readOnlyHint: true },
    async execute(input, { signal } = {}) {
      await delay(220, signal);
      return { query: input, journeys };
    },
  },
  {
    name: 'vectorrail.freeze_quote',
    title: 'Freeze a fare quote',
    description: 'Place a reversible temporary hold on one selected rail fare. This does not purchase a ticket or take payment.',
    inputSchema: {
      type: 'object',
      properties: { quoteId: { type: 'string', description: 'Selected fare quote identifier.' } },
      required: ['quoteId'],
    },
    annotations: { readOnlyHint: false },
    async execute({ quoteId }, { signal } = {}) {
      await delay(180, signal);
      const option = journeys.find((item) => item.quoteId === quoteId);
      if (!option) throw new Error(`Unknown rail quote: ${quoteId}`);
      return { holdId: `VR-HOLD-${quoteId}`, status: 'held', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), fare: option.fare };
    },
  },
];

bootProvider({ id: 'vectorrail', label: 'VectorRail', tools, initialMessage: 'Rail search and reversible fare-hold capabilities are ready.' });
