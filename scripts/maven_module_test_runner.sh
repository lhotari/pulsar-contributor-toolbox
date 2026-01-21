#!/usr/bin/env bash

# Maven Module Test Runner
# Groups tests by module and runs them together with comma-separated -Dtest parameter
# This is useful with Brokk as "Test Some Command" with {{#files}}"{{value}}" {{/files}} 
# as the arguments to this script

# When using in Brokk, set the shell to "/bin/zsh -c"
# If you are using SDKMAN and brew, move the initialization to ~/.zshenv file since that gets evaluated for all shells


set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to show usage
show_usage() {
    echo "Usage: $0 [OPTIONS] <file1> <file2> ... <fileN>"
    echo ""
    echo "Options:"
    echo "  -h, --help          Show this help message"
    echo "  -v, --verbose       Verbose output"
    echo "  -g, --goal GOAL     Maven goal to run (default: test)"
    echo "  -r, --root ROOT     Maven root directory (default: current directory)"
    echo ""
    echo "Example:"
    echo "  $0 pulsar-client/src/test/java/org/apache/pulsar/client/api/ConsumerIdTest.java \\"
    echo "     pulsar-client/src/test/java/org/apache/pulsar/client/api/RangeTest.java \\"
    echo "     pulsar-client/src/test/java/org/apache/pulsar/client/api/MessageIdTest.java"
    echo ""
    echo "This will run:"
    echo "  mvn -pl pulsar-client -Dtest=org/apache/pulsar/client/api/ConsumerIdTest.java,org/apache/pulsar/client/api/RangeTest.java,org/apache/pulsar/client/api/MessageIdTest.java test"
    exit 1
}

# Default values
VERBOSE=false
MAVEN_GOAL="test"
MAVEN_ROOT="."
MAVEN_TEST_ARGS="-DtestFailFast=false -DexcludedGroups='' --fail-at-end -DredirectTestOutputToFile=true -DtestRetryCount=0"

# Parse command line options
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_usage
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -g|--goal)
            MAVEN_GOAL="$2"
            shift 2
            ;;
        -r|--root)
            MAVEN_ROOT="$2"
            shift 2
            ;;
        -*)
            echo -e "${RED}Error: Unknown option $1${NC}"
            show_usage
            ;;
        *)
            break
            ;;
    esac
done

# Check if any file arguments provided
if [ $# -eq 0 ]; then
    echo -e "${RED}Error: No file paths provided${NC}"
    show_usage
fi

# Function for verbose logging
log_verbose() {
    if [ "$VERBOSE" = true ]; then
        echo -e "${BLUE}[VERBOSE]${NC} $1"
    fi
}

# Function to print colored output
print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# Associative array to group tests by module
declare -A module_tests
declare -A module_files

echo "Analyzing test file paths..."
echo "================================"

# Process each file argument
for file in "$@"; do
    log_verbose "Processing file: $file"

    # Extract class name from file name (remove .java extension)
    class_name=$(basename "$file" .java)

    # Check if the file exists and contains an abstract class definition with this class name
    if [ -f "$file" ]; then
        if grep -q -E "abstract\s+class\s+$class_name" "$file"; then
            print_warning "File '$file' contains an abstract class '$class_name' - skipping"
            continue
        fi
    fi

    # Check if file path contains "src/test/java"
    if [[ "$file" == *"src/test/java"* ]]; then
        # Extract module path (everything before "src/test/java")
        module_path="${file%%/src/test/java*}"
        
        # Extract test class path (everything after "src/test/java/")
        test_class_path="${file#*/src/test/java/}"
        
        log_verbose "Module: $module_path"
        log_verbose "Test class: $test_class_path"
        
        # Add test class to the module's test list
        if [[ -n "${module_tests[$module_path]}" ]]; then
            module_tests[$module_path]="${module_tests[$module_path]},$test_class_path"
            module_files[$module_path]="${module_files[$module_path]}
  $file"
        else
            module_tests[$module_path]="$test_class_path"
            module_files[$module_path]="  $file"
        fi
        
        echo "  $file → $module_path"
    else
        print_warning "File '$file' does not contain 'src/test/java' - skipping"
    fi
done

echo ""

# Check if we found any valid test files
if [ ${#module_tests[@]} -eq 0 ]; then
    print_error "No valid test file paths found"
    exit 1
fi

echo "Grouped tests by module:"
echo "========================"
for module in "${!module_tests[@]}"; do
    test_count=$(echo "${module_tests[$module]}" | tr ',' '\n' | wc -l)
    echo "Module: $module ($test_count test(s))"
    echo "${module_files[$module]}"
    echo "  → Tests: ${module_tests[$module]}"
    echo ""
done

# Check if Maven root directory exists and has pom.xml
if [ ! -d "$MAVEN_ROOT" ]; then
    print_error "Maven root directory '$MAVEN_ROOT' does not exist"
    exit 1
fi

if [ ! -f "$MAVEN_ROOT/pom.xml" ]; then
    print_error "No pom.xml found in Maven root directory '$MAVEN_ROOT'"
    exit 1
fi

# Change to Maven root directory
cd "$MAVEN_ROOT"
print_info "Running tests from Maven root: $(pwd)"
echo ""

# Arrays to track results
declare -a test_commands
declare -a test_modules
declare -a results
failed_modules=()
successful_modules=()

# Build and execute Maven commands for each module
for module in "${!module_tests[@]}"; do
    tests="${module_tests[$module]}"
    test_count=$(echo "$tests" | tr ',' '\n' | wc -l)
    
    print_info "Running $test_count test(s) for module: $module"
    
    # Build Maven command
    maven_cmd="mvn -pl $module -Dtest=$tests $MAVEN_GOAL $MAVEN_TEST_ARGS"
    
    test_commands+=("$maven_cmd")
    test_modules+=("$module")
    
    echo "Command: $maven_cmd"
    echo "----------------------------------------"
    
    log_verbose "Executing: $maven_cmd"
    
    if eval "$maven_cmd"; then
        print_success "Tests completed successfully for module: $module"
        results+=("SUCCESS")
        successful_modules+=("$module")
    else
        print_error "Tests failed for module: $module"
        results+=("FAILED")
        failed_modules+=("$module")
    fi
    
    echo ""
done

# Final summary
echo "Test Results Summary"
echo "===================="

if [ ${#successful_modules[@]} -gt 0 ]; then
    echo -e "${GREEN}Successful modules (${#successful_modules[@]}):${NC}"
    for module in "${successful_modules[@]}"; do
        test_count=$(echo "${module_tests[$module]}" | tr ',' '\n' | wc -l)
        echo "  ✓ $module ($test_count test(s))"
        if [ "$VERBOSE" = true ]; then
            echo "    Tests: ${module_tests[$module]}"
        fi
    done
    echo ""
fi

if [ ${#failed_modules[@]} -gt 0 ]; then
    echo -e "${RED}Failed modules (${#failed_modules[@]}):${NC}"
    for module in "${failed_modules[@]}"; do
        test_count=$(echo "${module_tests[$module]}" | tr ',' '\n' | wc -l)
        echo "  ✗ $module ($test_count test(s))"
        if [ "$VERBOSE" = true ]; then
            echo "    Tests: ${module_tests[$module]}"
        fi
    done
    echo ""
fi

# Display executed commands summary
if [ "$VERBOSE" = true ]; then
    echo "Commands executed:"
    for i in "${!test_commands[@]}"; do
        status="${results[$i]}"
        module="${test_modules[$i]}"
        if [ "$status" = "SUCCESS" ]; then
            echo -e "  ${GREEN}✓${NC} ${test_commands[$i]}"
        else
            echo -e "  ${RED}✗${NC} ${test_commands[$i]}"
        fi
    done
    echo ""
fi

# Calculate total test count
total_tests=0
for module in "${!module_tests[@]}"; do
    test_count=$(echo "${module_tests[$module]}" | tr ',' '\n' | wc -l)
    total_tests=$((total_tests + test_count))
done

# Exit with appropriate code
if [ ${#failed_modules[@]} -gt 0 ]; then
    print_error "Some modules failed. Modules: ${#failed_modules[@]} failed, ${#successful_modules[@]} successful (Total tests: $total_tests)"
    exit 1
else
    print_success "All tests completed successfully! Modules: ${#successful_modules[@]} successful (Total tests: $total_tests)"
    exit 0
fi