/**
 * Normalised property listing data.
 * Every site adapter maps its raw data into this shape.
 */
export interface PropertyListing {
  // Identification
  listingId: string;
  source: 'rightmove' | 'zoopla' | 'openrent';
  url: string;

  // Address (partial from listing, enriched later via EPC)
  displayAddress: string;
  postcode: string | null;       // Full postcode if available from listing
  postcodePartial: string | null; // Area-level postcode (always available)
  fullAddress: string | null;     // Set after EPC enrichment
  addressConfidence?: 'exact' | 'best_guess' | null; // How sure the EPC match is

  // Property details
  price: number | null;
  priceQualifier: string | null;  // "Guide price", "Offers over", etc.
  currency: string;               // GBP
  listingType: 'sale' | 'rent';
  bedrooms: number | null;
  propertyType: string | null;    // "Detached", "Flat", "Semi-detached", etc.

  // Agent / landlord contact
  agentName: string | null;
  agentPhone: string | null;
  agentBranch: string | null;

  // Location
  latitude: number | null;
  longitude: number | null;

  // Extra metadata (site-specific)
  tenure: string | null;
  furnished: string | null;
  deposit: number | null;
  epcRating: string | null;

  // Timestamps
  capturedAt: string;  // ISO 8601
}

/**
 * Interface every site adapter must implement.
 */
export interface SiteAdapter {
  /** Which site this adapter handles */
  site: PropertyListing['source'];

  /** URL patterns this adapter matches against */
  matchPatterns: RegExp[];

  /** Check if the current page URL is a property listing on this site */
  canHandle(url: string): boolean;

  /** Extract listing data from the current page DOM */
  extract(): Promise<PropertyListing>;
}

/**
 * Result from EPC API address enrichment
 */
export interface EpcResult {
  addressLines: string[]; // addressLine1-4, blank lines removed (line 1 = house number + street)
  postTown: string;
  postcode: string;
  currentEnergyRating: string;
  registrationDate: string;
  certificateNumber: string;
  uprn: string | null;
}
