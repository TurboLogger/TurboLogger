#!/bin/bash

# TurboLogger Production Deployment Script

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DOCKER_REGISTRY=${DOCKER_REGISTRY:-"turbologger"}
IMAGE_TAG=${IMAGE_TAG:-"latest"}
DEPLOYMENT_ENV=${DEPLOYMENT_ENV:-"production"}
NAMESPACE=${NAMESPACE:-"turbologger"}

echo -e "${BLUE}🚀 Starting TurboLogger deployment...${NC}"

# Function to print colored output
print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    echo -e "${BLUE}🔍 Checking prerequisites...${NC}"
    
    # Check if Docker is running
    if ! docker info >/dev/null 2>&1; then
        print_error "Docker is not running"
        exit 1
    fi
    print_status "Docker is running"
    
    # Check if kubectl is available
    if ! command -v kubectl &> /dev/null; then
        print_error "kubectl is not installed"
        exit 1
    fi
    print_status "kubectl is available"
    
    # Check if we can connect to Kubernetes cluster
    if ! kubectl cluster-info >/dev/null 2>&1; then
        print_error "Cannot connect to Kubernetes cluster"
        exit 1
    fi
    print_status "Connected to Kubernetes cluster"
}

# Build Docker image
build_image() {
    echo -e "${BLUE}🔨 Building Docker image...${NC}"
    
    cd "$(dirname "$0")/../../../"
    
    docker build \
        -f examples/production/docker/Dockerfile \
        -t "${DOCKER_REGISTRY}/turbologger:${IMAGE_TAG}" \
        -t "${DOCKER_REGISTRY}/turbologger:latest" \
        .
    
    print_status "Docker image built successfully"
}

# Push Docker image
push_image() {
    echo -e "${BLUE}📤 Pushing Docker image...${NC}"
    
    docker push "${DOCKER_REGISTRY}/turbologger:${IMAGE_TAG}"
    docker push "${DOCKER_REGISTRY}/turbologger:latest"
    
    print_status "Docker image pushed successfully"
}

# Deploy to Kubernetes
deploy_kubernetes() {
    echo -e "${BLUE}☸️ Deploying to Kubernetes...${NC}"
    
    cd "$(dirname "$0")/../kubernetes"
    
    # Create namespace if it doesn't exist
    kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
    print_status "Namespace created/updated"
    
    # Apply ConfigMap and Secrets
    kubectl apply -f configmap.yaml -n "${NAMESPACE}"
    print_status "ConfigMap applied"
    
    # Apply RBAC
    kubectl apply -f rbac.yaml -n "${NAMESPACE}"
    print_status "RBAC applied"
    
    # Apply Deployment
    sed "s|turbologger:latest|${DOCKER_REGISTRY}/turbologger:${IMAGE_TAG}|g" deployment.yaml | \
    kubectl apply -f - -n "${NAMESPACE}"
    print_status "Deployment applied"
    
    # Apply Service
    kubectl apply -f service.yaml -n "${NAMESPACE}"
    print_status "Service applied"
    
    # Apply HPA
    kubectl apply -f hpa.yaml -n "${NAMESPACE}"
    print_status "HorizontalPodAutoscaler applied"
    
    # Apply Ingress (optional)
    if [[ -f ingress.yaml ]]; then
        kubectl apply -f ingress.yaml -n "${NAMESPACE}"
        print_status "Ingress applied"
    fi
}

# Wait for deployment to be ready
wait_for_deployment() {
    echo -e "${BLUE}⏳ Waiting for deployment to be ready...${NC}"
    
    kubectl wait --for=condition=available --timeout=300s deployment/turbologger-app -n "${NAMESPACE}"
    print_status "Deployment is ready"
    
    # Check pod status
    kubectl get pods -n "${NAMESPACE}" -l app.kubernetes.io/name=turbologger
}

# Run health checks
health_checks() {
    echo -e "${BLUE}🏥 Running health checks...${NC}"
    
    # Get service IP
    SERVICE_IP=$(kubectl get svc turbologger-service -n "${NAMESPACE}" -o jsonpath='{.spec.clusterIP}')
    
    # Port forward for testing
    kubectl port-forward svc/turbologger-service 8080:80 -n "${NAMESPACE}" &
    PORT_FORWARD_PID=$!
    
    sleep 5
    
    # Health check
    if curl -f http://localhost:8080/health >/dev/null 2>&1; then
        print_status "Health check passed"
    else
        print_error "Health check failed"
        kill $PORT_FORWARD_PID 2>/dev/null || true
        exit 1
    fi
    
    # Readiness check
    if curl -f http://localhost:8080/ready >/dev/null 2>&1; then
        print_status "Readiness check passed"
    else
        print_warning "Readiness check failed - deployment may still be starting"
    fi
    
    # Metrics check
    if curl -f http://localhost:8080/metrics >/dev/null 2>&1; then
        print_status "Metrics endpoint accessible"
    else
        print_warning "Metrics endpoint not accessible"
    fi
    
    kill $PORT_FORWARD_PID 2>/dev/null || true
}

# Deploy monitoring stack
deploy_monitoring() {
    echo -e "${BLUE}📊 Deploying monitoring stack...${NC}"
    
    cd "$(dirname "$0")/../"
    
    # Deploy with Docker Compose
    if [[ -f docker/docker-compose.yml ]]; then
        docker-compose -f docker/docker-compose.yml up -d prometheus grafana
        print_status "Monitoring stack deployed"
    else
        print_warning "Docker Compose file not found - skipping monitoring deployment"
    fi
}

# Performance test
performance_test() {
    echo -e "${BLUE}⚡ Running performance test...${NC}"
    
    # Port forward for testing
    kubectl port-forward svc/turbologger-service 8080:80 -n "${NAMESPACE}" &
    PORT_FORWARD_PID=$!
    
    sleep 5
    
    # Simple load test
    echo "Running bulk log test..."
    curl -X POST http://localhost:8080/api/logs/bulk \
        -H "Content-Type: application/json" \
        -d '{"count": 1000}' \
        --max-time 30
    
    if [[ $? -eq 0 ]]; then
        print_status "Performance test completed"
    else
        print_warning "Performance test encountered issues"
    fi
    
    kill $PORT_FORWARD_PID 2>/dev/null || true
}

# Cleanup function
cleanup() {
    echo -e "${BLUE}🧹 Cleaning up...${NC}"
    
    # Kill any background processes
    jobs -p | xargs -r kill 2>/dev/null || true
    
    print_status "Cleanup completed"
}

# Rollback function
rollback() {
    echo -e "${YELLOW}🔄 Rolling back deployment...${NC}"
    
    kubectl rollout undo deployment/turbologger-app -n "${NAMESPACE}"
    kubectl rollout status deployment/turbologger-app -n "${NAMESPACE}"
    
    print_status "Rollback completed"
}

# Main deployment function
main() {
    # Set trap for cleanup
    trap cleanup EXIT
    
    case "${1:-deploy}" in
        "check")
            check_prerequisites
            ;;
        "build")
            check_prerequisites
            build_image
            ;;
        "push")
            check_prerequisites
            build_image
            push_image
            ;;
        "deploy")
            check_prerequisites
            build_image
            push_image
            deploy_kubernetes
            wait_for_deployment
            health_checks
            ;;
        "monitoring")
            deploy_monitoring
            ;;
        "test")
            performance_test
            ;;
        "rollback")
            rollback
            ;;
        "all")
            check_prerequisites
            build_image
            push_image
            deploy_kubernetes
            wait_for_deployment
            health_checks
            deploy_monitoring
            performance_test
            ;;
        *)
            echo "Usage: $0 {check|build|push|deploy|monitoring|test|rollback|all}"
            echo ""
            echo "Commands:"
            echo "  check      - Check prerequisites"
            echo "  build      - Build Docker image"
            echo "  push       - Build and push Docker image"
            echo "  deploy     - Full deployment to Kubernetes"
            echo "  monitoring - Deploy monitoring stack"
            echo "  test       - Run performance tests"
            echo "  rollback   - Rollback to previous deployment"
            echo "  all        - Run complete deployment pipeline"
            exit 1
            ;;
    esac
}

# Run main function
main "$@"

echo -e "${GREEN}🎉 Deployment completed successfully!${NC}"