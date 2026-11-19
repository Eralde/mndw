// Package status defines categories consumed by cmd/generate-rci-session-contract.
package status

type Category string

const (
	Transient             Category = "transient"
	Unauthorized          Category = "unauthorized"
	Validation            Category = "validation"
	RedemptionFailed      Category = "redemption-failed"
	ControllerUnavailable Category = "controller-unavailable"
	MalformedResponse     Category = "malformed-response"
)

func Values() []Category {
	return []Category{
		Transient,
		Unauthorized,
		Validation,
		RedemptionFailed,
		ControllerUnavailable,
		MalformedResponse,
	}
}

func IsValid(value Category) bool {
	for _, candidate := range Values() {
		if value == candidate {
			return true
		}
	}

	return false
}
