export interface ProductOffer {
  supermarket: string;   // ex.: "Continente", "Pingo Doce", ...
  brand: string;         // ex.: "Continente", "Salsa", "Gallo"
  name: string;          // designação do produto
  price: number;         // preço atual em euros
  unitPrice?: number;    // preço por kg/l/un (quando disponível)
  unit?: string;         // ex.: "kg", "L", "un"
  url?: string;          // link para o produto na loja
  promo?: string;        // texto da promoção, se existir
}

export interface SupermarketError {
  supermarket: string;
  reason: string;
}

export interface SearchResponse {
  query: string;
  offers: ProductOffer[];
  errors: SupermarketError[];
}
