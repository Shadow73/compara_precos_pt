// Dados fictícios para desenvolver a UI sem aceder aos sites.
// Ativado com DEMO_MODE=true (ver .env.example).

const DEMO_DATA = {
  'arroz agulha': [
    { supermarket: 'Continente', brand: 'Continente', name: 'Arroz Agulha Continente 1 Kg', price: 1.29, unitPrice: 1.29, unit: 'kg', promo: '-15%' },
    { supermarket: 'Pingo Doce', brand: 'Pingo Doce', name: 'Arroz Agulha Pingo Doce 1 Kg', price: 1.19, unitPrice: 1.19, unit: 'kg' },
    { supermarket: 'Auchan', brand: 'Auchan', name: 'Arroz Agulha Auchan 1 Kg', price: 1.25, unitPrice: 1.25, unit: 'kg' },
    { supermarket: 'Intermarché', brand: 'Alvorada', name: 'Arroz Agulha Alvorada 1 Kg', price: 1.35, unitPrice: 1.35, unit: 'kg' },
  ],
};

export function searchDemo(query) {
  const q = query.toLowerCase();
  const match = Object.entries(DEMO_DATA).find(([k]) => q.includes(k.split(' ')[0]));
  return match ? match[1] : [];
}
