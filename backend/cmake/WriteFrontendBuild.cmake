# Stamp the assets being packaged, not the running server or a branch label.
# Also used for frontend-only deployments; never writes into the source tree.
if(NOT SOURCE_DIR OR NOT OUTPUT_DIR)
    message(FATAL_ERROR "SOURCE_DIR and OUTPUT_DIR are required")
endif()
file(REAL_PATH "${SOURCE_DIR}/frontend" source_frontend)
file(REAL_PATH "${OUTPUT_DIR}" output_frontend)
if(output_frontend STREQUAL source_frontend)
    message(FATAL_ERROR "Generate build metadata in a staging directory, not frontend/")
endif()
find_package(Git QUIET)
set(revision "")
set(dirty true)
if(Git_FOUND)
    execute_process(COMMAND "${GIT_EXECUTABLE}" -C "${SOURCE_DIR}" rev-parse HEAD
        RESULT_VARIABLE rc OUTPUT_VARIABLE revision OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
    if(NOT rc EQUAL 0 OR NOT revision MATCHES "^[0-9a-f]+$")
        set(revision "")
    else()
        execute_process(COMMAND "${GIT_EXECUTABLE}" -C "${SOURCE_DIR}" status --porcelain --untracked-files=normal
            RESULT_VARIABLE status_rc OUTPUT_VARIABLE changes ERROR_QUIET)
        if(status_rc EQUAL 0 AND changes STREQUAL "")
            set(dirty false)
        endif()
    endif()
endif()
# Source archives/container contexts omit .git. The packager may supply the
# exact source revision explicitly; never infer it from the release label.
if(revision STREQUAL "" AND NOT "${SOURCE_REVISION}" STREQUAL "")
    string(LENGTH "${SOURCE_REVISION}" revision_length)
    if(NOT SOURCE_REVISION MATCHES "^[0-9a-f]+$" OR
       NOT (revision_length EQUAL 40 OR revision_length EQUAL 64))
        message(FATAL_ERROR "SOURCE_REVISION must be a full Git commit hash")
    endif()
    set(revision "${SOURCE_REVISION}")
    set(dirty false)
endif()
file(MAKE_DIRECTORY "${OUTPUT_DIR}/js/util")
file(WRITE "${OUTPUT_DIR}/js/util/FrontendBuild.js"
    "// Generated during packaging. Source revision, not a release/merge label.\nexport const frontendBuild = Object.freeze({ revision: '${revision}', dirty: ${dirty} });\n")
