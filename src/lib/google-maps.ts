interface ComputeRoutesResponse {
	routes?: Array<{
		distanceMeters?: number;
	}>;
	error?: {
		code?: number;
		message?: string;
		status?: string;
	};
}

/**
 * Computes road driving distance in integer meters using Google Maps Routes API v2.
 * Uses TRAFFIC_UNAWARE + minimal FieldMask (`routes.distanceMeters`) for lowest billing tier.
 */
export async function computeDrivingDistanceMeters(
	apiKey: string,
	originAddress: string,
	destinationAddress: string
): Promise<number> {
	if (!apiKey.trim()) {
		throw new Error("Google Maps API Key is not configured");
	}
	if (!originAddress.trim() || !destinationAddress.trim()) {
		throw new Error("Both origin and destination addresses are required");
	}

	const response = await fetch(
		"https://routes.googleapis.com/directions/v2:computeRoutes",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Goog-Api-Key": apiKey.trim(),
				"X-Goog-FieldMask": "routes.distanceMeters",
			},
			body: JSON.stringify({
				origin: { address: originAddress.trim() },
				destination: { address: destinationAddress.trim() },
				travelMode: "DRIVE",
				routingPreference: "TRAFFIC_UNAWARE",
				units: "METRIC",
			}),
		}
	);

	const data = (await response.json()) as ComputeRoutesResponse;

	if (!response.ok) {
		const msg = data.error?.message || `HTTP ${response.status}`;
		throw new Error(`Google Routes API error: ${msg}`);
	}

	const distanceMeters = data.routes?.[0]?.distanceMeters;
	if (typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters)) {
		throw new Error(
			`No driving route found between "${originAddress}" and "${destinationAddress}"`
		);
	}

	return Math.round(distanceMeters);
}
