package events

import (
	contractEvents "mndw.local/contracts/events"
)

type InternalPublisher struct {
	bus        *Bus
	normalizer *Normalizer
}

func NewInternalPublisher(bus *Bus, normalizer *Normalizer) *InternalPublisher {
	return &InternalPublisher{bus: bus, normalizer: normalizer}
}

func (p *InternalPublisher) publishPayload(topic contractEvents.Topic, payload any) error {
	event, err := p.normalizer.NormalizeInternal(topic, payload)
	if err != nil {
		return err
	}

	p.bus.Publish(event)

	return nil
}

func (p *InternalPublisher) PublishPluginInstalled(payload contractEvents.PluginInstalledPayload) error {
	return p.publishPayload(contractEvents.TopicPluginInstalled, payload)
}

func (p *InternalPublisher) PublishPluginApproved(payload contractEvents.PluginApprovedPayload) error {
	return p.publishPayload(contractEvents.TopicPluginApproved, payload)
}

func (p *InternalPublisher) PublishPluginRemoved(payload contractEvents.PluginRemovedPayload) error {
	return p.publishPayload(contractEvents.TopicPluginRemoved, payload)
}

func (p *InternalPublisher) PublishPluginStarted(payload contractEvents.PluginStartedPayload) error {
	return p.publishPayload(contractEvents.TopicPluginStarted, payload)
}

func (p *InternalPublisher) PublishPluginStopped(payload contractEvents.PluginStoppedPayload) error {
	return p.publishPayload(contractEvents.TopicPluginStopped, payload)
}

func (p *InternalPublisher) PublishDaemonStarted(payload contractEvents.DaemonStartedPayload) error {
	return p.publishPayload(contractEvents.TopicDaemonStarted, payload)
}

func (p *InternalPublisher) PublishDaemonStopping(payload contractEvents.DaemonStoppingPayload) error {
	return p.publishPayload(contractEvents.TopicDaemonStopping, payload)
}

func (p *InternalPublisher) PublishDaemonUpdated(payload contractEvents.DaemonUpdatedPayload) error {
	return p.publishPayload(contractEvents.TopicDaemonUpdated, payload)
}

func (p *InternalPublisher) PublishStorageLow(payload contractEvents.StorageLowPayload) error {
	return p.publishPayload(contractEvents.TopicStorageLow, payload)
}
