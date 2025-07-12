# TurboLogger Production Deployment Guide

This directory contains production-ready deployment configurations and examples for TurboLogger, designed to help you deploy a high-performance logging solution in enterprise environments.

## 🚀 Quick Start

### Prerequisites

- **Docker** 20.10+ and Docker Compose 2.0+
- **Kubernetes** 1.20+ (for Kubernetes deployment)
- **kubectl** configured with cluster access
- **Node.js** 18+ (for local development)

### Environment Variables

```bash
# Core Configuration
export NODE_ENV=production
export LOG_LEVEL=info
export TURBOLOGGER_MODE=ultra

# Cloud Provider Credentials (optional)
export AWS_REGION=us-east-1
export GCP_PROJECT_ID=your-project-id
export AZURE_CONNECTION_STRING=your-connection-string

# Container Registry
export DOCKER_REGISTRY=your-registry.com
export IMAGE_TAG=v1.0.0
```

## 📦 Deployment Options

### 1. Docker Compose (Recommended for Development/Testing)

```bash
cd examples/production/docker
docker-compose up -d
```

This deploys:
- TurboLogger application
- Redis (for caching and streaming)
- Elasticsearch (for log storage)
- Kibana (for log visualization)
- Prometheus (for metrics)
- Grafana (for dashboards)
- Jaeger (for distributed tracing)

### 2. Kubernetes (Recommended for Production)

```bash
# Quick deployment
./scripts/deploy.sh deploy

# Or step by step
./scripts/deploy.sh check      # Check prerequisites
./scripts/deploy.sh build      # Build Docker image
./scripts/deploy.sh push       # Push to registry
./scripts/deploy.sh deploy     # Deploy to Kubernetes
./scripts/deploy.sh monitoring # Deploy monitoring stack
./scripts/deploy.sh test       # Run performance tests
```

## 🏗️ Architecture

### Components

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Application   │───▶│   TurboLogger   │───▶│   Transports    │
│    Instances    │    │     Core        │    │                 │
└─────────────────┘    └─────────────────┘    │ • File          │
                                              │ • Console       │
┌─────────────────┐    ┌─────────────────┐    │ • CloudWatch    │
│   Load          │───▶│   Ingress       │    │ • Stackdriver   │
│   Balancer      │    │   Controller    │    │ • Azure Monitor │
└─────────────────┘    └─────────────────┘    │ • Elasticsearch │
                                              └─────────────────┘
┌─────────────────┐    ┌─────────────────┐    
│   Monitoring    │    │   Observability │    
│                 │    │                 │    
│ • Prometheus    │    │ • Metrics       │    
│ • Grafana       │    │ • Tracing       │    
│ • Alertmanager  │    │ • Health Checks │    
└─────────────────┘    └─────────────────┘    
```

### Data Flow

1. **Log Ingestion**: Applications send logs to TurboLogger
2. **Processing**: Logs are processed, sampled, and enriched
3. **Transport**: Logs are sent to configured destinations
4. **Monitoring**: Metrics and traces are collected
5. **Alerting**: Alerts are triggered based on thresholds

## ⚙️ Configuration

### Production Configuration (`config/production.json`)

```json
{
  "performance": {
    "mode": "ultra",
    "zeroAllocation": true,
    "bufferSize": 65536,
    "flushInterval": 500
  },
  "security": {
    "piiMasking": {
      "enabled": true,
      "autoDetect": true,
      "strictMode": true
    },
    "compliance": ["gdpr", "hipaa", "pci-dss"],
    "encryption": {
      "enabled": true,
      "algorithm": "aes-256-gcm"
    }
  },
  "sampling": {
    "enabled": true,
    "targetRate": 0.9,
    "adaptiveOptions": {
      "enabled": true,
      "memoryThreshold": 90,
      "cpuThreshold": 85
    }
  }
}
```

### Environment-Specific Overrides

- **Development**: Higher log levels, more verbose output
- **Staging**: Production-like with additional debugging
- **Production**: Optimized for performance and security

## 🔧 Kubernetes Configuration

### Resource Requirements

```yaml
resources:
  requests:
    memory: "256Mi"
    cpu: "200m"
  limits:
    memory: "512Mi"
    cpu: "500m"
```

### Horizontal Pod Autoscaling

- **Min Replicas**: 3
- **Max Replicas**: 20
- **CPU Target**: 70%
- **Memory Target**: 80%
- **Custom Metrics**: logs/second

### Security

- **RBAC**: Minimal required permissions
- **Pod Security**: Non-root user, read-only filesystem
- **Network Policies**: Restricted ingress/egress
- **Secrets Management**: Encrypted at rest

## 📊 Monitoring & Observability

### Metrics

TurboLogger exposes Prometheus metrics at `/metrics`:

```
# Log throughput
turbologger_logs_total
turbologger_logs_per_second

# Performance
turbologger_memory_usage_bytes
turbologger_cpu_usage_percent
turbologger_buffer_utilization

# Transport health
turbologger_transport_latency_ms
turbologger_transport_errors_total

# Sampling
turbologger_sampling_rate
turbologger_sampling_decisions_total
```

### Dashboards

Pre-configured Grafana dashboards include:

1. **Overview**: High-level metrics and health
2. **Performance**: Detailed performance metrics
3. **Errors**: Error tracking and analysis
4. **Sampling**: Sampling rate and decisions
5. **Transports**: Transport-specific metrics

### Alerts

Critical alerts configured:

- High error rate (>5%)
- Memory usage (>85%)
- Transport failures
- Buffer near capacity (>90%)
- Instance down

## 🚨 Troubleshooting

### Common Issues

#### 1. High Memory Usage

```bash
# Check memory metrics
kubectl top pods -n turbologger

# Adjust buffer size
kubectl patch configmap turbologger-config -n turbologger \
  --patch '{"data":{"turbologger.json":"{\"performance\":{\"bufferSize\":32768}}"}}'
```

#### 2. Transport Failures

```bash
# Check transport logs
kubectl logs -n turbologger deployment/turbologger-app | grep transport

# Verify credentials
kubectl describe secret turbologger-secrets -n turbologger
```

#### 3. High Error Rate

```bash
# Check recent errors
kubectl logs -n turbologger deployment/turbologger-app --tail=100 | grep ERROR

# Scale up instances
kubectl scale deployment turbologger-app --replicas=5 -n turbologger
```

### Debug Mode

Enable debug mode for troubleshooting:

```bash
kubectl set env deployment/turbologger-app LOG_LEVEL=debug -n turbologger
```

## 🔄 Scaling

### Vertical Scaling

Increase resource limits:

```bash
kubectl patch deployment turbologger-app -n turbologger --patch '{
  "spec": {
    "template": {
      "spec": {
        "containers": [{
          "name": "turbologger",
          "resources": {
            "limits": {"memory": "1Gi", "cpu": "1"}
          }
        }]
      }
    }
  }
}'
```

### Horizontal Scaling

The HPA automatically scales based on:
- CPU utilization
- Memory utilization  
- Custom metrics (logs/second)

Manual scaling:

```bash
kubectl scale deployment turbologger-app --replicas=10 -n turbologger
```

## 🔒 Security Best Practices

### 1. Network Security

- Use TLS for all communications
- Implement network policies
- Restrict ingress to necessary ports

### 2. Data Protection

- Enable PII masking and auto-detection
- Use encryption for sensitive data
- Implement proper RBAC

### 3. Compliance

TurboLogger supports compliance with:
- **GDPR**: Data anonymization and deletion
- **HIPAA**: PHI detection and masking
- **PCI-DSS**: Credit card data protection

## 📈 Performance Tuning

### High-Throughput Configuration

For >100k logs/second:

```json
{
  "performance": {
    "mode": "ultra",
    "zeroAllocation": true,
    "bufferSize": 131072,
    "flushInterval": 100
  },
  "sampling": {
    "targetRate": 0.1,
    "adaptiveOptions": {
      "enabled": true,
      "aggressiveMode": true
    }
  }
}
```

### Memory-Constrained Environments

For limited memory:

```json
{
  "performance": {
    "mode": "standard",
    "bufferSize": 16384,
    "compression": {"enabled": true}
  },
  "sampling": {
    "targetRate": 0.05
  }
}
```

## 🚀 Advanced Features

### 1. Multi-Cloud Setup

Deploy across multiple cloud providers:

```yaml
transports:
  - type: "cloudwatch"
    region: "us-east-1"
  - type: "stackdriver" 
    projectId: "gcp-project"
  - type: "azure-monitor"
    connectionString: "azure-connection"
```

### 2. Geographic Distribution

Use regional deployments with centralized aggregation:

```bash
# Deploy to multiple regions
for region in us-east-1 us-west-2 eu-west-1; do
  helm install turbologger-$region ./helm/turbologger \
    --set region=$region \
    --set aggregation.central.enabled=true
done
```

### 3. Custom Metrics

Add application-specific metrics:

```typescript
import { TurboMetrics } from '@oxog/turbologger';

const metrics = new TurboMetrics();
const requestDuration = metrics.histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration',
  buckets: [10, 50, 100, 500, 1000]
});
```

## 📝 Maintenance

### Regular Tasks

1. **Log Rotation**: Automated via configuration
2. **Index Cleanup**: Remove old Elasticsearch indices  
3. **Metrics Retention**: Configure Prometheus retention
4. **Backup**: Regular backup of configuration and dashboards

### Updates

```bash
# Rolling update
./scripts/deploy.sh push
kubectl set image deployment/turbologger-app turbologger=turbologger:new-tag -n turbologger

# Rollback if needed
./scripts/deploy.sh rollback
```

## 📞 Support

For production support and enterprise features:

- 📧 Email: ersinkoc@gmail.com
- 🐛 Issues: https://github.com/TurboLogger/TurboLogger/issues
- 📚 Repository: https://github.com/TurboLogger/TurboLogger

## 📄 License

This production deployment guide is part of TurboLogger and is licensed under the MIT License.