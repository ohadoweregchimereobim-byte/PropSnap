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
  addressConfidence?: 'exact' | 'best_guess' | 'user_choice' | null; // How sure the EPC match is; user_choice = picked by the user
  addressCandidates?: AddressCandidate[] | null;   // On a best guess, the close homes the user can choose from (best guess first)
  enrichmentDetail?: string | null; // What the EPC match was based on, e.g. "Exact: matched on house number"

  // Property details
  price: number | null;
  priceQualifier: string | null;  // "Guide price", "Offers over", etc.
  currency: string;               // GBP
  listingType: 'sale' | 'rent';
  bedrooms: number | null;
  propertyType: string | null;    // "Detached", "Flat", "Semi-detached", etc.
  floorAreaSqm?: number | null;   // Internal floor area in square metres, when the listing shows it
  floorAreaFromText?: number | null; // Floor area read from the description text; used only when the setting allows
  floorAreaSource?: 'listing' | 'text' | null; // Where floorAreaSqm came from
  numberFromText?: string | null; // Flat/house number read from the listing text when the address hides it

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

/** One of the close homes from the EPC register, kept so the user can pick the right one */
export interface AddressCandidate {
  fullAddress: string;
  postcode: string;
  certificateNumber: string;
  epcRating: string | null;
  floorAreaSqm?: number | null;
  propertyType?: string | null;
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

  // Filled from the certificate itself when the search row does not carry them
  propertyType?: string | null;   // "House", "Flat", "Bungalow", "Maisonette"
  builtForm?: string | null;      // "Detached", "Semi-Detached", "Mid-Terrace", ...
  floorAreaSqm?: number | null;
  habitableRooms?: number | null;
}
